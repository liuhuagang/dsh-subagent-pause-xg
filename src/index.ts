/**
 * dsh-subagent-pause-xg：父会话有活跃子代理时自动暂停其 agent 回合的插件。
 *
 * 问题背景：本地单路 llama.cpp（单 slot）被主会话与子代理交错请求，KV 前缀缓存
 * 互相击穿（每次请求整段重 prefill）。根因是主会话在等待子代理期间仍持续自主
 * Think 发请求（"空闲焦虑"插话）。本插件在机制层拦截：主会话派生子代理后，
 * 其 agent 回合在每次 LLM 请求前的必经拦截点（agent/pre-step waterfall）被
 * `{ kind: 'reject' }` 终止（回合以 blocked 结束，LLM 请求根本不产生），
 * 子代理报告送达父会话 inbox 时按 DSH 唤醒机制自动恢复。
 *
 * 机制依据（DSH 源码，见 README「原理」）：
 * - packages/core/agent-loop/src/agent.ts:234 agent/pre-step waterfall 是每次
 *   LLM 请求前的必经拦截点；监听器返回 { kind: 'reject' } 时回合以 blocked 结束
 *   （agent.ts:267-269），agent 进入 idle 等待 inbox 新消息唤醒（agent.ts:198-199）。
 * - subagent/start / subagent/end 是子代理生命周期的唯一发射点（覆盖 in-process
 *   spawn/fork 与 continuable），按 runId 配对（packages/subagent/subagent/src/lifecycle.ts）。
 * - 报告/结算通知投递会唤醒 idle 父会话（continuation.ts notifySettlement →
 *   followup/steer；tool-jobs 完成通知 → followup），因此本插件无需自建唤醒。
 * - reject 会结束本 step 已 claim 的 inbox 消息（不 append 不退回），所以
 *   只有"真实外部输入"的 claim 必须放行（用户输入 / 子代理报告 / 结算通知 /
 *   后台任务完成通知），其余一律拦截。
 * - v1.1.1 判定收紧：实测本版 DSH agent-loop 中回合内续步全部由工具结果经
 *   inbox splice 驱动（claim 恒 ≥1），旧判定（claimedCount === 0 才拦截）从未
 *   触发——主会话派生子代理后仍能靠自己的工具链持续发 LLM 请求，与子代理
 *   交错占用单 slot（KV 前缀缓存互相击穿）。现在活跃期间**除真实外部输入外
 *   一律拦截**（含工具结果驱动的续步）：拦截只丢弃 inbox claim，tool/result
 *   事件已持久化在会话日志，父会话恢复时仍可见，不丢信息。
 *
 * 开关机制（settings）：
 * - 通过 ctx.inject(['settings']) 下的 settings.installSection 注册 settings
 *   namespace `subagent-pause`，cordis.patch.yml 的 config 作为 composition
 *   base 层；settings.yaml 的 user 层优先。`applies: 'live'`——运行时修改
 *   settings.yaml（GUI 设置页"打开配置文件"或直接编辑）立即生效，无需重启。
 * - settings 服务缺失时回退 composition entry，行为与旧版完全一致。
 * - 监听器始终注册（enabled=false 时仅放行不拦截），保证运行时重新开启可用。
 *
 * 暂停/恢复语义：
 * - 派生子代理（subagent/start）→ 该父会话后续所有非外部输入续步被拦截
 *   （回合 blocked，零 LLM 请求），包括工具结果驱动的续步
 * - 子代理完成（subagent/end）→ 活跃计数归零 → 报告送达唤醒后放行
 * - 子代理活跃期间用户手动输入 → 放行处理（人机交互优先，消息不丢）
 * - 子代理又派生子代理 → 对每个 agent 独立判定，递归自然成立
 * - 进程重启后父会话恢复（resume）：旧子代理已随进程终止，活跃表为空 → 不拦截
 * - goal 交互：goal 轮次 prompt（source.kind='goal'）不是外部输入，活跃期间会被
 *   拦截，goal-round-driver 会把该 goal 标记为 blocked（'prompt-rejected'）；
 *   **最后一个活跃子代理结算后本插件自动 resume 该 goal**（autoResumeGoal 开关，
 *   默认 true），goal 从下一轮继续，无需手动干预
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { PauseTracker, shouldPause, shouldAutoResumeGoal, type GoalStateLike, type ModelFilter } from './logic.js'

export const name = 'dsh-subagent-pause-xg'

/** 解析后的插件配置（schema 默认值 + composition base + settings user 层） */
export interface Config {
  /** 总开关；false 时不拦截（监听器仍注册，运行时可在设置里重新开启），默认 true */
  enabled: boolean
  /**
   * 最后一个活跃子代理结算后，若父会话的 goal 因本插件冻结被 blocked
   * （blockedReason.code === 'prompt-rejected'），自动 resume 该 goal；
   * 默认 true
   */
  autoResumeGoal: boolean
  /** 只对指定 provider/model 生效（任一维度省略 = 通配），默认全部 */
  modelFilter?: ModelFilter
  /** 每条 start/end/reject 都 console.log + ctx.logger（默认 true；调 false 只留 blocked 摘要） */
  verbose: boolean
}

/** settings namespace `subagent-pause` 的 schema（同时是插件 Config 的解析器） */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  autoResumeGoal: z.boolean().default(true),
  // 字段可省略（省略 = 通配）；default(undefined) 表示配置未提供时整个 filter 缺省
  modelFilter: z.object({
    provider: z.string(),
    model: z.string(),
  }).default(undefined as never),
  verbose: z.boolean().default(true),
})

/** 从 composition entry 构建解析后的默认配置 */
function entryConfig(config: Partial<Config>): Config {
  // schema 调用对缺省字段以 default 填充（运行时宽容；类型断言仅消除 z<T> 全量签名）
  return Config(config as Config)
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  // 当前权威配置来源：settings 存在时 = settings scope.get()，否则 = entry。
  // 监听器每次读取（读闭包开销可忽略），运行时开关即时生效。
  let source: () => Config = () => entryConfig(config)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, 'subagent-pause', Config, entryConfig(config), {
      setSource: (current) => { source = current },
      onChange: () => {
        const value = source()
        log(`设置已变更: enabled=${value.enabled} verbose=${value.verbose} modelFilter=[${filterText(value.modelFilter)}]`)
      },
    })
  })

  const tracker = new PauseTracker()

  /** 双通道日志：console（终端可见）+ ctx.logger（结构化 buffer） */
  function log(text: string): void {
    console.log(`[dsh-subagent-pause-xg] ${text}`)
    ctx.logger.info(`[dsh-subagent-pause-xg] ${text}`)
  }

  function filterText(filter: ModelFilter | null | undefined): string {
    return filter == null
      ? '全部'
      : `provider=${filter.provider ?? '*'}, model=${filter.model ?? '*'}`
  }

  // agents 注册表用于在 subagent/start 时解析子代理的父会话（事件 payload 无
  // parent 字段；start 通知期间 in-process 子代理已注册，可查 session header）。
  // 用 ctx.get 而非 inject：本插件不需要阻塞激活等待 agents。
  const agents = ctx.get('agents')

  /**
   * 最后一个活跃子代理结算后，自动 resume 被本插件冻结的 goal。
   *
   * 背景：goal 轮次 prompt 不是外部输入，冻结期间会被拦截，goal-round-driver
   * 随即把 goal 标记为 blocked（code 'prompt-rejected'）。子代理全部结束后若
   * 不处理，goal 会一直停在 blocked 需要手动 resume。本函数在最后一个
   * subagent/end 时检查父会话的当前 goal：phase === 'blocked' 且
   * blockedReason.code === 'prompt-rejected' → 自动 resume（重新 armed，
   * goal-round-driver 的 goal/changed 监听会排队下一轮）。
   *
   * 顺序说明：continuable 子代理的结算通知在 subagent/end 之前送达父会话
   * （continuation.ts notifySettlement → settle），因此 resume 时父会话正在
   * 处理报告或已 idle；driver 的 drive() 只在 idle 时排队轮次 prompt，报告
   * 先于新 goal 轮被处理，无竞态。
   *
   * 失败全部兜底：goals 服务缺失（无 goal 包）→ 跳过；goal 读取/resume 抛错
   * → 记日志不抛（不破坏 end 事件发布）。
   */
  function autoResumeFreezeBlockedGoal(parentId: string): void {
    const current = source()
    if (!current.enabled || !current.autoResumeGoal) return
    const goals = ctx.get('goals')
    if (goals === undefined) return
    // parentId 源自子代理 session header 的 parentSession（真实 SessionId），
    // 此处仅做结构断言以绕过品牌类型（不引入 dsh-session 依赖）。
    const parent = (agents as { get(id: string): Agent | undefined } | undefined)?.get(parentId)
    if (parent === undefined) return
    try {
      const goal: GoalStateLike | undefined = goals.get(parent)
      if (!shouldAutoResumeGoal(goal)) return
      goals.resume(parent, { id: goal.id, revision: goal.revision })
      log(`goal 自动 resume: agent=${parentId} goal=${goal.id}（子代理全部结束，解除 prompt-rejected 冻结）`)
    } catch (error) {
      log(`goal 自动 resume 失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  /**
   * 解析一次 subagent/start 的父会话 id。
   * in-process 子代理（spawn/fork）的 agent 已注册 → session.header.parentSession。
   * 外部进程 provider（acp 等）在本地 registry 无 agent → 返回 undefined（不追踪，
   * 其子代理不占本地推理 slot，无需暂停）。
   */
  function resolveParentId(info: SubagentRunInfo): string | undefined {
    const child = agents?.get(info.id)
    const parentId = child?.session.header.parentSession
    return parentId === undefined ? undefined : parentId
  }

  // 1. subagent/start：登记活跃 run。监听器异常不得影响发布，整体兜底。
  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    try {
      const parentId = resolveParentId(info)
      if (parentId === undefined) {
        // 非 in-process 子代理：不追踪（不占本地推理 slot，暂停无意义）
        if (source().verbose) log(`subagent/start skip（外部进程，无本地 agent）: child=${String(info.id)} provider=${info.provider}`)
        return
      }
      tracker.start(String(info.runId), parentId, String(info.id))
      if (source().verbose) {
        log(`subagent/start child=${String(info.id)} parent=${parentId} run=${String(info.runId)} provider=${info.provider}（活跃子代理数=${tracker.activeCount(parentId)}）`)
      }
    } catch (error) {
      log(`subagent/start 处理失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  })

  // 2. subagent/end：按 runId 配对移除。end 时子代理可能已从 registry 移除，
  //    无法再解析父会话，必须靠 start 时建立的 runId → parentId 映射回查。
  //    最后一个活跃子代理结束时：若父会话的 goal 因本插件冻结被 blocked
  //    （prompt-rejected），自动 resume（见 autoResumeFreezeBlockedGoal）。
  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    try {
      const record = tracker.end(String(info.runId))
      if (record !== undefined) {
        if (tracker.activeCount(record.parentId) === 0) {
          autoResumeFreezeBlockedGoal(record.parentId)
        }
        if (source().verbose) {
          log(`subagent/end child=${String(info.id)} run=${String(info.runId)} stopReason=${info.stopReason}（剩余活跃子代理数=${tracker.total()}）`)
        }
      }
    } catch (error) {
      log(`subagent/end 处理失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  })

  // 3. agent/pre-step：核心拦截点。有活跃子代理且本 step 无真实外部输入
  //    （用户输入 / 子代理报告 / 结算通知 / 后台任务完成通知）→ reject
  //    （回合 blocked，零 LLM 请求）；否则放行（next()）。
  //    监听器整体 try/catch：任何异常都放行，绝不 veto 正常请求。
  //    注意：本监听器始终注册——enabled 由 source() 实时判定，运行时开关立即生效。
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      const current = source()
      if (!current.enabled) return next()
      const provider = agent.options.provider ?? ''
      const model = agent.options.model ?? ''
      if (!shouldPause(tracker, agent.id, messages, current.modelFilter, provider, model)) {
        return next()
      }
      log(`回合 blocked: agent=${agent.id}（${provider}/${model}）等待 ${tracker.activeCount(agent.id)} 个活跃子代理，本轮不产生 LLM 请求`)
      return { kind: 'reject' }
    } catch (error) {
      log(`pre-step 处理失败，放行: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      return next()
    }
  })

  // 4. agent/disposed：清理该 agent 相关的活跃记录（父会话销毁 → 其子代理 run
  //    作废；子代理销毁 → 其 start 记录作废），避免泄漏与误拦截。
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    try {
      const removed = tracker.clearAgent(agent.id)
      if (removed > 0 && source().verbose) {
        log(`agent ${agent.id} 销毁，清理 ${removed} 条活跃子代理记录（剩余 ${tracker.total()}）`)
      }
    } catch (error) {
      log(`agent/disposed 处理失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  })

  log(`subagent-pause 已启动: enabled=${source().enabled} autoResumeGoal=${source().autoResumeGoal} modelFilter=[${filterText(source().modelFilter)}] verbose=${source().verbose}（当前活跃 run=${tracker.total()}）`)
}
