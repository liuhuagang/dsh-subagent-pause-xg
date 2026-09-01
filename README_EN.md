# dsh-subagent-pause-xg

<div align="center">
  <sub><a href="README.md">简体中文</a> | <b>English</b></sub>
</div>

> [!NOTE] Maintenance status
> This plugin is an internal tool of the XG series, **provided for reference/learning only, no maintenance is promised** (issues are not guaranteed to be answered).
> The latest development version is maintained in the internal GitLab XGDSHPlugins; this repository is a source snapshot.

DSH plugin: when the parent session has an active subagent, automatically pause the parent session's agent turns (no LLM request is generated); automatically resume when the subagent's report is delivered.

## Why it is needed

With a local single-route llama.cpp (single slot) being requested interleaved by the main session and its subagents, the KV prefix cache is repeatedly broken through—each request re-prefills the entire segment (176K history ≈ 100s+). The root cause is that the main session keeps autonomously Thinking and sending requests while waiting for the subagent ("idle anxiety" interjections).

Queuing (serializing requests) cannot solve the interleaving problem, because every "idle anxiety" request of the main session repeatedly breaks the cache around the subagent's requests. This plugin pauses the parent session's turns at the **mechanism layer**: after spawning a subagent, the parent session no longer generates any LLM request until the subagent's report is delivered.

> v1.1.1 tightened criteria (test-driven): the old criteria only intercepted "empty steps with no claim message", but in this version of the DSH agent-loop, in-turn continuations are all driven by tool results via inbox splice (claim is always ≥1), so the old criteria never triggered—the main session could still keep sending requests through its own tool chain (read/edit/grep/...) after spawning a subagent. New criteria: during the active period, **everything except real external input is intercepted** (including tool-result-driven continuations). Interception only drops the inbox claim; tool/result events are already persisted in the session log and remain visible when the parent session resumes—no information is lost.

## How it works

| Stage | Mechanism (DSH source) |
|------|------------------|
| Interception point | `agent/pre-step` waterfall is the mandatory interception point before every LLM request (`packages/core/agent-loop/src/agent.ts:234`). When the listener returns `{ kind: 'reject' }`, the turn ends with `blocked` (agent.ts:267-269) and the LLM request is never generated; the agent enters idle, waiting for a new inbox message to wake it (agent.ts:198-199) |
| Active subagent detection | `subagent/start` / `subagent/end` are the only emission points of the subagent lifecycle (`packages/subagent/subagent/src/lifecycle.ts` `observeRun` / `createActivationObserver`), covering all providers (including in-process spawn/fork) and continuable Activation cycles, paired one-to-one by `runId`. **The start → end interval = the active interval** |
| Parent session resolution | The event payload has no parent field. During the `subagent/start` notification, the in-process subagent is already registered, and the parent session is resolved via `ctx.agents.get(info.id).session.header.parentSession`; at `subagent/end` the subagent may already have been removed from the registry, so it must fall back to the `runId → parentId` mapping established at start |
| Wake-up | No waking is needed by this plugin: a continuable subagent's settlement notification `followup`s the idle parent session (`continuation.ts` notifySettlement), and a one-shot background job's completion notification `followup`s the idle owner (tool-jobs); a report/notification entering the inbox wakes it |
| Message protection | `reject` ends the inbox messages already claimed in this step (not appended, not returned). Therefore **the claim of real external input must be allowed through**, and everything else is intercepted. External input = determined by the message `source`: `kind: 'user'` (human input), `kind: 'subagent-report'` (continuable subagent report relay), `kind: 'subagent-settled'` (continuable subagent settlement notification), `kind: 'plugin' + plugin: 'tool-jobs'` (one-shot background subagent completion notification). Tool result contexts (plugin/fs etc.), goal round prompts (`kind: 'goal'`), compression summaries, etc. are **not** external input and are intercepted normally during the active period |

### Pause / resume semantics

- Spawning a subagent (`subagent/start`) → all subsequent non-external-input continuations of that parent session are intercepted: the turn is blocked with zero LLM requests (including tool-result-driven continuations)
- Subagent completes (`subagent/end`) → the active record is removed → the report is delivered and wakes it, then is allowed through and the turn continues normally
- The user manually inputs while the subagent is active → allowed through (human-machine interaction takes priority, messages are not lost)
- A subagent spawns another subagent → judged independently for each agent (the active table is looked up by each `agent.id`), so recursion holds naturally; when the grandchild completes, it wakes the layers one by one
- After a process restart, the parent session resumes: old subagents have already terminated with the process, the active table is empty → no interception, behavior is correct

### Interaction with goal sessions

The goal round prompt (`source.kind: 'goal'`) is not external input, so it is intercepted during the active period. At that point goal-round-driver marks that goal as `blocked` (`prompt-rejected`: goal round was rejected before entering its step)—i.e. the goal auto-pauses during the freeze.

**After the last active subagent settles, this plugin automatically resumes that goal** (`autoResumeGoal` switch, default true): at subagent/end, it checks the parent session's current goal; if `blockedReason.code === 'prompt-rejected'`, it calls `ctx.goals.resume` to re-arm it, and goal-round-driver then queues the next round so the goal continues from where it froze—no manual intervention. The report has already been delivered to the parent session before subagent/end (continuation.ts notifySettlement → settle), so the report is processed first and the new goal round starts after—no race condition.

With `autoResumeGoal: false`, the old behavior is retained: the goal stays at blocked and must be manually resumed in the GUI or via `update_goal` (resume action).

### Why not live queries / counting

- `subagent/listChildren` returns **all** durable subagents (including finished ones; `activity: 'running'` only means the session record is in the store), so it cannot judge activity on its own
- A subagent agent does not auto-dispose on completion, and persisted sessions are retained long-term—"an agent is in the registry" also cannot judge activity
- Pure counting (`Map<parentId, number>`) cannot locate the parent session at `subagent/end` (the payload has no parent, and the subagent may already be unregistered)—the `runId → parentId` mapping must be used

## Configuration (settings take priority; cordis.patch.yml is the default layer)

The plugin registers the settings namespace `subagent-pause` via `settings.installSection` (`ctx.inject([`settings`])`) (`applies: 'live'`); config priority: **schema defaults < cordis.patch.yml config (composition base layer) < the `~/.dsh/settings.yaml` user layer**. When the settings service is missing, it falls back to the patch config and behaves the same as pure static config.

**Runtime switches** (no restart needed):

```yaml
# ~/.dsh/settings.yaml
subagent-pause:
  enabled: false          # disable the pause → takes effect immediately (live)
  autoResumeGoal: false   # do not auto-resume the frozen goal after the last subagent settles (default true)
```

Choose any way to change them: edit `~/.dsh/settings.yaml` directly (settings-file has a watcher; saving pushes it); or the Web GUI settings page → Plugins → the **「子代理暂停（subagent-pause）」** card in the "configurable plugins" tab (enabled/verbose switches + provider/model filter inputs, saving takes effect immediately); or the GUI settings page → "open config file" and edit it with a system editor.

The config in patch acts as the default layer (effective when settings do not override it):

```yaml
- insert:
    - id: subagent-pause
      name: 'dsh-subagent-pause-xg'
      config:
        enabled: true            # on by default; settings.yaml can override at runtime
        autoResumeGoal: true     # auto-resume the frozen goal after the last subagent settles
        modelFilter:             # optional: only effective for the specified provider/model
          provider: 'llama-local' #   omitting either dimension = wildcard; no config = all
        verbose: true            # every start/end/reject is logged on both channels
```

Note: when `enabled: false` the listener is still registered (it just allows through without intercepting), so re-enabling it in the settings at runtime takes effect immediately—no restart is needed.

## Logging

Dual-channel convention (`console.log('[dsh-subagent-pause-xg] ...')` terminal-visible + `ctx.logger.info` structured buffer). Key logs:

```
[dsh-subagent-pause-xg] subagent-pause 已启动: enabled=true autoResumeGoal=true modelFilter=[全部] verbose=true（当前活跃 run=0）
[dsh-subagent-pause-xg] subagent/start child=xxx parent=yyy run=zzz provider=spawn（活跃子代理数=1）
[dsh-subagent-pause-xg] 回合 blocked: agent=yyy（llama-local/qwen）等待 1 个活跃子代理，本轮不产生 LLM 请求
[dsh-subagent-pause-xg] subagent/end child=xxx run=zzz stopReason=completed（剩余活跃子代理数=0）
[dsh-subagent-pause-xg] goal 自动 resume: agent=yyy goal=goal-xxx（子代理全部结束，解除 prompt-rejected 冻结）
```

## Deployment

1. Build: `node scripts/build.mjs` (tsdown client bundle → host tsc → client type check → artifact verification → unit tests, all in one step)
2. Copy `lib/` and `package.json` to `~/.dsh/profiles/web/node_modules/dsh-subagent-pause-xg/`
3. Add the entry above to `cordis.patch.yml` (default layer)
4. Restart DSH (`pnpm dsh web`)—the startup log showing `subagent-pause 已启动` means it is active; the configurable-plugin card appearing in the GUI settings page means the client half is partially live

## Client half (settings card)

`src/client/` (tsdown build → `lib/client.js`, ModuleLoader single-file bundle):

- Registers a collapsible card in `settings.plugin.item` (keyed slot, key = namespace `subagent-pause`): enabled/verbose switches + the modelFilter provider/model inputs, staged editing + save/discard; write path `scope.set/unset` → `settings.mutate`, saving takes effect live
- Follows the client pattern of dsh-token-stats: structural types (no import of client runtime packages), inline CSS (theme tokens, light/dark adaptive), react external (module table injection)
- `exports` must expose both the `./client` and `./package.json` subpaths (when `./package.json` is missing, the client half is silently judged as having no client, see PLUGIN-DEVELOPMENT.md §五)

## Development

- Source `src/` (the logic layer `logic.ts` is separated from the plugin entry `index.ts`, allowing independent unit testing)
- Unit tests: `node --test tests/logic.spec.mjs`
- The judgment logic is all in `logic.ts` (`PauseTracker` active table + `shouldPause` decision) and does not depend on cordis
- Switch wiring is in `index.ts`: under `ctx.inject([`settings`])`, `settings.installSection` registers the namespace `subagent-pause` (entry as the base layer), and the listener reads the current value via `source()` each time—no derived state, so runtime switches take effect immediately

## Verification checklist (runtime)

1. After the main session (llama-local) spawns a subagent, the terminal shows the `回合 blocked` marker, and during this period the main session generates zero LLM requests (no new requests in llama.cpp /metrics or router.log)—including the main session's own tool-chain continuations also being intercepted (v1.1.1 core verification point)
2. The subagent executes continuously without interruption
3. After the subagent's report is delivered, the main session automatically resumes a new turn (the terminal turn continues)
4. After the subagent completes, the main session's requests return to normal with no residual blocking
5. Goal session: while the subagent is active, the goal is marked `blocked` (prompt-rejected); after the last subagent settles, the terminal shows `goal 自动 resume` and the goal automatically continues from the next round (no manual resume needed; with `autoResumeGoal: false` a manual resume is still required)
