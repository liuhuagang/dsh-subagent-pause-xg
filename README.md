# dsh-subagent-pause-xg

**简体中文** · [English](README_EN.md)

> [!NOTE] 维护状态
> 本插件为 XG 系列内部工具，**仅供学习参考，不承诺维护**（issue 不保证响应）。
> 最新开发版维护于内网 GitLab XGDSHPlugins；本仓库为源码快照。

DSH 插件：父会话有活跃子代理时，自动暂停父会话的 agent 回合（不产生 LLM
请求）；子代理报告送达后自动恢复。

## 为什么需要

本地单路 llama.cpp（单 slot）被主会话与子代理交错请求时，KV 前缀缓存互相
击穿——每次请求整段重 prefill（176K 历史 ≈ 100s+）。根因是主会话在等待子代理
期间仍持续自主 Think 发请求（"空闲焦虑"插话）。

排队（串行化请求）解决不了交错问题，因为主会话的每个"空闲焦虑"请求都会在
子代理请求前后反复击穿缓存。本插件在**机制层**暂停父会话回合：派生子代理后，
父会话不再产生任何 LLM 请求，直到子代理报告送达。

> v1.1.1 判定收紧（实测驱动）：旧判定只在"无 claim 消息的空 step"拦截，但
> 本版 DSH agent-loop 中回合内续步全部由工具结果经 inbox splice 驱动
> （claim 恒 ≥1），旧判定从未触发——主会话派生子代理后仍能靠自己的工具链
> （read/edit/grep/...）持续发请求。新判定：活跃期间**除真实外部输入外一律
> 拦截**（含工具结果驱动的续步）。拦截只丢弃 inbox claim，tool/result 事件
> 已持久化在会话日志，父会话恢复时仍可见，不丢信息。

## 原理

| 环节 | 机制（DSH 源码） |
|------|------------------|
| 拦截点 | `agent/pre-step` waterfall 是每次 LLM 请求前的必经拦截点（`packages/core/agent-loop/src/agent.ts:234`）。监听器返回 `{ kind: 'reject' }` 时回合以 `blocked` 结束（agent.ts:267-269），LLM 请求根本不产生；agent 进入 idle，等待 inbox 新消息唤醒（agent.ts:198-199） |
| 活跃子代理判定 | `subagent/start` / `subagent/end` 是子代理生命周期的唯一发射点（`packages/subagent/subagent/src/lifecycle.ts` 的 `observeRun` / `createActivationObserver`），覆盖所有 provider（含 in-process spawn/fork）与 continuable Activation 周期，按 `runId` 一一配对。**start → end 区间 = 活跃区间** |
| 父会话解析 | 事件 payload 无 parent 字段。`subagent/start` 通知期间 in-process 子代理已注册，经 `ctx.agents.get(info.id).session.header.parentSession` 解析父会话；`subagent/end` 时子代理可能已从 registry 移除，因此必须靠 start 时建立的 `runId → parentId` 映射回查 |
| 唤醒 | 无需本插件唤醒：continuable 子代理结算通知对 idle 父会话 `followup`（`continuation.ts` notifySettlement），one-shot 后台 job 完成通知对 idle owner `followup`（tool-jobs），报告/通知进入 inbox 即唤醒 |
| 消息保护 | `reject` 会结束本 step 已 claim 的 inbox 消息（不 append、不退回）。因此**真实外部输入的 claim 必须放行**，其余一律拦截。外部输入 = 按消息 `source` 判定：`kind: 'user'`（真人输入）、`kind: 'subagent-report'`（continuable 子代理报告转达）、`kind: 'subagent-settled'`（continuable 子代理结算通知）、`kind: 'plugin' + plugin: 'tool-jobs'`（一次性后台子代理完成通知）。工具结果上下文（plugin/fs 等）、goal 轮次 prompt（`kind: 'goal'`）、压缩摘要等**不是**外部输入，活跃期间照常拦截 |

### 暂停 / 恢复语义

- 派生子代理（`subagent/start`）→ 该父会话后续所有非外部输入续步被拦截：回合 blocked，零 LLM 请求（含工具结果驱动的续步）
- 子代理完成（`subagent/end`）→ 活跃记录移除 → 报告送达唤醒后放行，回合正常继续
- 子代理活跃期间用户手动输入 → 放行处理（人机交互优先，消息不丢）
- 子代理又派生子代理 → 对每个 agent 独立判定（按各自 `agent.id` 查活跃表），递归自然成立；孙代理完成时逐层唤醒
- 进程重启后父会话恢复（resume）：旧子代理已随进程终止，活跃表为空 → 不拦截，行为正确

### 与 goal 会话的交互

goal 轮次 prompt（`source.kind: 'goal'`）不是外部输入，活跃期间会被拦截。此时
goal-round-driver 会把该 goal 标记为 `blocked`（`prompt-rejected`：goal round was
rejected before entering its step）——即冻结期间 goal 自动暂停。

**最后一个活跃子代理结算后，本插件自动 resume 该 goal**（`autoResumeGoal` 开关，
默认 true）：subagent/end 时检查父会话当前 goal，若 `blockedReason.code ===
'prompt-rejected'` 则调用 `ctx.goals.resume` 重新 armed，goal-round-driver 随即
排队下一轮，goal 从冻结处继续，无需手动干预。报告在 subagent/end 之前已送达
父会话（continuation.ts notifySettlement → settle），因此报告先处理、新 goal 轮
后启动，无竞态。

`autoResumeGoal: false` 时保留旧行为：goal 停在 blocked，需在 GUI 或经
`update_goal`（resume 动作）手动恢复。

### 为什么不用实时查询 / 计数

- `subagent/listChildren` 返回**所有** durable 子代理（含已结束，`activity: 'running'`
  仅表示 session 记录在 store），不能单独判定活跃
- 子代理 agent 完成不自动 dispose、持久化 session 长期保留——"registry 中有 agent"
  也不能判定活跃
- 纯计数（`Map<parentId, 数字>`）在 `subagent/end` 时无法定位父会话（payload 无
  parent，子代理可能已 unregister）——必须用 `runId → parentId` 映射

## 配置（settings 优先，cordis.patch.yml 为默认层）

插件经 `settings.installSection`（ctx.inject([`settings`])）注册 settings namespace `subagent-pause`
（`applies: 'live'`），配置优先级：**schema 默认值 < cordis.patch.yml 的
config（composition base 层）< `~/.dsh/settings.yaml` 的 user 层**。
settings 服务缺失时回退 patch config，行为与纯静态配置一致。

**运行时开关**（无需重启）：

```yaml
# ~/.dsh/settings.yaml
subagent-pause:
  enabled: false          # 关闭暂停 → 立即生效（live）
  autoResumeGoal: false   # 最后一个子代理结算后不自动 resume 被冻结的 goal（默认 true）
```

修改方式任选：直接编辑 `~/.dsh/settings.yaml`（settings-file 有 watcher，保存
即推送）；或 Web GUI 设置页 → 插件 → 「可配置插件」tab 的
**「子代理暂停（subagent-pause）」卡片**（enabled/verbose 开关 + provider/model
过滤输入，保存即生效）；或 GUI 设置页 → 「打开配置文件」用系统编辑器修改。

patch 里的 config 作为默认层（settings 未覆盖时生效）：

```yaml
- insert:
    - id: subagent-pause
      name: 'dsh-subagent-pause-xg'
      config:
        enabled: true            # 默认开启；settings.yaml 可运行时覆盖
        autoResumeGoal: true     # 最后一个子代理结算后自动 resume 被冻结的 goal
        modelFilter:             # 可选：只对指定 provider/model 生效
          provider: 'llama-local' #   任一维度省略 = 通配；不配置 = 全部
        verbose: true            # 每条 start/end/reject 都双通道日志
```

注意：`enabled: false` 时监听器仍注册（只是放行不拦截），因此运行时在设置里
重新开启立即生效，无需重启。

## 日志

双通道约定（`console.log('[dsh-subagent-pause-xg] ...')` 终端可见 +
`ctx.logger.info` 结构化 buffer）。关键日志：

```
[dsh-subagent-pause-xg] subagent-pause 已启动: enabled=true autoResumeGoal=true modelFilter=[全部] verbose=true（当前活跃 run=0）
[dsh-subagent-pause-xg] subagent/start child=xxx parent=yyy run=zzz provider=spawn（活跃子代理数=1）
[dsh-subagent-pause-xg] 回合 blocked: agent=yyy（llama-local/qwen）等待 1 个活跃子代理，本轮不产生 LLM 请求
[dsh-subagent-pause-xg] subagent/end child=xxx run=zzz stopReason=completed（剩余活跃子代理数=0）
[dsh-subagent-pause-xg] goal 自动 resume: agent=yyy goal=goal-xxx（子代理全部结束，解除 prompt-rejected 冻结）
```

## 部署

1. 构建：`node scripts/build.mjs`（tsdown 客户端 bundle → 宿主 tsc → 客户端
   类型检查 → 产物验证 → 单元测试，一步完成）
2. 复制 `lib/` 与 `package.json` 到
   `~/.dsh/profiles/web/node_modules/dsh-subagent-pause-xg/`
3. `cordis.patch.yml` 添加上述条目（默认层）
4. 重启 DSH（`pnpm dsh web`）——启动日志出现 `subagent-pause 已启动` 即生效；
   GUI 设置页「可配置插件」出现卡片即客户端半生效

## 客户端半（设置卡片）

`src/client/`（tsdown 构建 → `lib/client.js`，ModuleLoader 单文件 bundle）：

- 在 `settings.plugin.item`（keyed slot，key = namespace `subagent-pause`）
  注册折叠卡片：enabled/verbose 开关 + modelFilter 的 provider/model 输入，
  staged 编辑 + 保存/放弃；写路径 `scope.set/unset` → `settings.mutate`，
  保存即 live 生效
- 遵循 dsh-token-stats 的客户端模式：结构性类型（不 import 客户端运行时包）、
  内联 CSS（主题 token，浅色/深色自适应）、react external（模块表注入）
- `exports` 必须同时暴露 `./client` 与 `./package.json` 子路径（缺
  `./package.json` 时客户端半被静默判为无客户端，见 PLUGIN-DEVELOPMENT.md §五）

## 开发

- 源码 `src/`（逻辑层 `logic.ts` 与插件入口 `index.ts` 分离，可独立单测）
- 单元测试：`node --test tests/logic.spec.mjs`
- 判定逻辑全部在 `logic.ts`（`PauseTracker` 活跃表 + `shouldPause` 决策），不依赖 cordis
- 开关接线在 `index.ts`：`ctx.inject([`settings`])` 下 `settings.installSection` 注册 namespace
  `subagent-pause`（entry 作 base 层），监听器每次经 `source()` 读当前值——无
  派生状态，运行时开关即时生效

## 验证清单（运行时）

1. 主会话（llama-local）派生子代理后，终端出现 `回合 blocked` 标记，
   期间主会话零 LLM 请求（llama.cpp /metrics 或 router.log 无新请求）——
   包括主会话自己的工具链续步也被拦（v1.1.1 核心验证点）
2. 子代理连续执行不被打断
3. 子代理报告送达后主会话自动恢复新回合（终端回合继续）
4. 子代理完成后主会话请求恢复正常，无残留阻塞
5. goal 会话：子代理活跃期间 goal 被标记 blocked（prompt-rejected）；最后一个
   子代理结算后终端出现 `goal 自动 resume`，goal 从下一轮自动继续（无需手动
   恢复；autoResumeGoal: false 时仍需手动 resume）
