/**
 * dsh-subagent-pause-xg 纯逻辑层：活跃子代理追踪（subagent/start → end 配对）
 * 与 pre-step 暂停判定。
 *
 * 本文件只使用标准 JS 数据结构，不依赖 cordis，所有函数与类可独立单元测试。
 *
 * 设计依据（DSH 源码机制，见 README「原理」）：
 * - `subagent/start` / `subagent/end` 是唯一生命周期发射点（@deepseek-ai/dsh-subagent
 *   的 observeRun / createActivationObserver），覆盖所有 provider（含 in-process
 *   spawn/fork）与 continuable Activation 周期；两者按 `runId` 一一配对。
 * - run 的"活跃区间" = start 事件到 end 事件之间。子代理 agent 的存活（registry
 *   存在）或 session 的 store 状态都不能判定活跃（agent 完成不自动 dispose，
 *   持久化 session 长期保留），只有 start/end 区间语义准确。
 * - pre-step 拦截语义：`{ kind: 'reject' }` 使回合以 `blocked` 结束，LLM 请求不产生，
 *   且**该 step 已 claim 的 inbox 消息随之结束**（不 append、不退回）。因此
 *   "有 claim 消息"的 pre-step 必须放行（用户输入、报告通知、工具结果），否则会丢消息；
 *   只有"无 claim 消息"的 pre-step（回合内自主续步 / 自主 Think）才应拦截。
 */

/** 一条活跃子代理 run 的登记记录（start 时建立，end 时移除） */
export interface ActiveRunRecord {
  /** 生命周期配对键：每次 start/end 唯一（one-shot 每次 start 一个；continuable 每次 Activation 一个） */
  readonly runId: string
  /** 委托方父会话 id（subagent/start 时经 ctx.agents 从子代理 session header 解析） */
  readonly parentId: string
  /** 子代理会话 id（info.id） */
  readonly childId: string
}

/** modelFilter 配置：任一维度省略 = 通配 */
export interface ModelFilter {
  /** 只匹配该 provider 名（如 'llama-local'）；省略 = 全部 provider */
  provider?: string
  /** 只匹配该 model 名；省略 = 全部 model */
  model?: string
}

/**
 * 活跃子代理追踪器。双索引：runId → 记录（end 按 runId 精确配对），
 * parentId → Set<runId>（pre-step 按父会话快速判定）。
 *
 * 为什么不只用 Map<parentId, 计数>：end 事件没有 parent 字段（事件按 scope
 * carrier 派发，payload 只有 runId/provider/id），且 end 时子代理 agent 可能
 * 已从 registry 移除，无法再解析父会话——必须靠 start 时建立的 runId → parentId
 * 映射回查。runId 比 childId 更精确：continuable 子代理的多个 Activation 周期
 * 共享同一 childId，但每次周期有独立 runId。
 */
export class PauseTracker {
  private readonly runs = new Map<string, ActiveRunRecord>()
  private readonly byParent = new Map<string, Set<string>>()

  /** 登记一次 subagent/start。重复 runId 视为幂等（保留首次记录）。 */
  start(runId: string, parentId: string, childId: string): void {
    if (this.runs.has(runId)) return
    this.runs.set(runId, { runId, parentId, childId })
    let ids = this.byParent.get(parentId)
    if (ids === undefined) {
      ids = new Set()
      this.byParent.set(parentId, ids)
    }
    ids.add(runId)
  }

  /** 移除一次 subagent/end（按 runId 配对）。无匹配记录返回 false。 */
  end(runId: string): boolean {
    const record = this.runs.get(runId)
    if (record === undefined) return false
    this.runs.delete(runId)
    const ids = this.byParent.get(record.parentId)
    if (ids !== undefined) {
      ids.delete(runId)
      if (ids.size === 0) this.byParent.delete(record.parentId)
    }
    return true
  }

  /** 某父会话当前是否有活跃子代理 */
  hasActive(parentId: string): boolean {
    return (this.byParent.get(parentId)?.size ?? 0) > 0
  }

  /** 某父会话当前活跃子代理 run 数（日志用） */
  activeCount(parentId: string): number {
    return this.byParent.get(parentId)?.size ?? 0
  }

  /** 当前活跃 run 总数 */
  total(): number {
    return this.runs.size
  }

  /**
   * 清除某 agent 相关的全部记录（agent/disposed 时调用）：
   * - 该 agent 作为父会话：其全部活跃子代理 run 作废（父会话销毁后子代理
   *   的 subagent/end 不会再被本插件观察到）
   * - 该 agent 作为子代理：其 start 记录作废（避免 runId 泄漏）
   * @returns 清除的 run 数
   */
  clearAgent(agentId: string): number {
    let removed = 0
    const parentIds = this.byParent.get(agentId)
    if (parentIds !== undefined) {
      for (const runId of parentIds) {
        if (this.runs.delete(runId)) removed += 1
      }
      this.byParent.delete(agentId)
    }
    for (const [runId, record] of this.runs) {
      if (record.childId === agentId) {
        this.runs.delete(runId)
        removed += 1
        const ids = this.byParent.get(record.parentId)
        if (ids !== undefined) {
          ids.delete(runId)
          if (ids.size === 0) this.byParent.delete(record.parentId)
        }
      }
    }
    return removed
  }

  /** 活跃记录快照（调试 / 日志用，按登记顺序） */
  snapshot(): ActiveRunRecord[] {
    return [...this.runs.values()]
  }
}

/** modelFilter 匹配：未配置（undefined/null）视为通配 */
export function matchesModelFilter(filter: ModelFilter | null | undefined, provider: string, model: string): boolean {
  if (filter == null) return true
  if (filter.provider !== undefined && filter.provider !== provider) return false
  if (filter.model !== undefined && filter.model !== model) return false
  return true
}

/**
 * pre-step 暂停判定（唯一决策点）：
 * 满足全部条件才拦截（返回 true）：
 *   1. modelFilter 匹配（配置了过滤且不匹配 → 放行）
 *   2. 该 agent 有活跃子代理
 *   3. 本 step 无已 claim 的 inbox 消息（有消息必须放行：reject 会丢弃消息）
 * @param tracker        活跃子代理追踪器
 * @param agentId        发起 pre-step 的 agent 会话 id
 * @param claimedCount   本 step 已 claim 的 inbox 消息数（payload.messages.length）
 * @param filter         modelFilter 配置
 * @param provider       agent 的 provider（agent.options.provider ?? ''）
 * @param model          agent 的 model（agent.options.model ?? ''）
 */
export function shouldPause(
  tracker: PauseTracker,
  agentId: string,
  claimedCount: number,
  filter: ModelFilter | null | undefined,
  provider: string,
  model: string,
): boolean {
  if (!matchesModelFilter(filter, provider, model)) return false
  return tracker.hasActive(agentId) && claimedCount === 0
}