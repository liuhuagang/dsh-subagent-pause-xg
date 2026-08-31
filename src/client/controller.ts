/**
 * dsh-subagent-pause-xg 客户端表单控制器。
 *
 * 极简 staged 表单：字段草稿（enabled/verbose 布尔 + modelFilter 的
 * provider/model 文本）从 settings scope 的 resolved value 派生，用户编辑
 * 只改草稿，Save 一次性写 set/unset，Discard 重置草稿。
 *
 * 类型全部为结构性声明（不 import 运行时包）：与
 * @deepseek-ai/dsh-client-runtime/client 的 SettingsScope 契约一致。
 */

/** settings scope 的结构性契约（客户端运行时 SettingsScope<T>） */
export interface SettingsScopeLike<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
    mode: 'host' | 'memory'
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** 插件 settings namespace 的 section 形状（与宿主 Config 一致） */
export interface PauseSettingsSection {
  enabled?: boolean
  autoResumeGoal?: boolean
  verbose?: boolean
  modelFilter?: { provider?: string; model?: string }
}

/** 可编辑字段 */
export type PauseField = 'enabled' | 'autoResumeGoal' | 'verbose' | 'provider' | 'model'

/** 表单草稿（resolved 视图，布尔带 schema 默认值） */
export interface PauseCardDraft {
  enabled: boolean
  autoResumeGoal: boolean
  verbose: boolean
  provider: string
  model: string
}

/** 卡片渲染状态 */
export interface PauseCardState {
  /** namespace 是否已由宿主注册（未注册渲染空） */
  available: boolean
  /** 宿主文档是否可写 */
  writable: boolean
  /** 是否有未保存修改 */
  dirty: boolean
  /** 是否正在保存 */
  saving: boolean
  /** 上次保存是否失败 */
  failed: boolean
  /** 当前草稿 */
  draft: PauseCardDraft
}

/** 卡片 slot 的注入面（组件 props） */
export interface PauseCardFace {
  getState(): PauseCardState
  subscribe(listener: () => void): () => void
  edit(field: PauseField, value: boolean | string): void
  save(): void
  discard(): void
}

/** 从 resolved value 派生草稿（缺省按 schema 默认值） */
function seedDraft(value: PauseSettingsSection | undefined): PauseCardDraft {
  return {
    enabled: value?.enabled ?? true,
    autoResumeGoal: value?.autoResumeGoal ?? true,
    verbose: value?.verbose ?? true,
    provider: value?.modelFilter?.provider ?? '',
    model: value?.modelFilter?.model ?? '',
  }
}

/** 草稿间是否相等 */
function draftsEqual(a: PauseCardDraft, b: PauseCardDraft): boolean {
  return a.enabled === b.enabled && a.autoResumeGoal === b.autoResumeGoal
    && a.verbose === b.verbose && a.provider === b.provider && a.model === b.model
}

export class PauseCardController {
  private draft: PauseCardDraft
  private saving = false
  private failed = false
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(private readonly scope: SettingsScopeLike<PauseSettingsSection>) {
    this.draft = seedDraft(scope.getSnapshot().value)
    // scope 推送（含自身写后回读）时重新发布；草稿保留用户编辑，dirty 判定实时重算
    this.unsubscribe = scope.subscribe(() => this.publish())
  }

  /** 释放订阅（插件 fiber 卸载时调用） */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private resolved(): PauseCardDraft {
    return seedDraft(this.scope.getSnapshot().value)
  }

  private dirty(): boolean {
    return !draftsEqual(this.draft, this.resolved())
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  getState(): PauseCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.dirty(),
      saving: this.saving,
      failed: this.failed,
      draft: this.draft,
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  edit(field: PauseField, value: boolean | string): void {
    if (this.saving) return
    if (field === 'enabled' || field === 'autoResumeGoal' || field === 'verbose') {
      if (typeof value !== 'boolean') return
      this.draft = { ...this.draft, [field]: value }
    } else {
      if (typeof value !== 'string') return
      this.draft = { ...this.draft, [field]: value }
    }
    this.failed = false
    this.publish()
  }

  /**
   * 写入全部变更字段：布尔直写；modelFilter 以完整对象写（空字段剔除，
   * 全空则 unset 整个字段）。await 全部落盘后草稿随 scope 回读自然对齐。
   */
  async save(): Promise<void> {
    if (this.saving || !this.dirty()) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const next = this.draft
      const current = this.resolved()
      if (next.enabled !== current.enabled) await this.scope.set('enabled', next.enabled)
      if (next.autoResumeGoal !== current.autoResumeGoal) await this.scope.set('autoResumeGoal', next.autoResumeGoal)
      if (next.verbose !== current.verbose) await this.scope.set('verbose', next.verbose)
      const filterChanged = next.provider !== current.provider || next.model !== current.model
      if (filterChanged) {
        if (next.provider === '' && next.model === '') {
          await this.scope.unset('modelFilter')
        } else {
          await this.scope.set('modelFilter', {
            ...next.provider !== '' ? { provider: next.provider } : {},
            ...next.model !== '' ? { model: next.model } : {},
          })
        }
      }
    } catch (_error) {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }

  discard(): void {
    if (this.saving) return
    this.draft = this.resolved()
    this.failed = false
    this.publish()
  }

  /** 构造 slot 注入面 */
  inject(): PauseCardFace {
    return {
      getState: () => this.getState(),
      subscribe: (listener) => this.subscribe(listener),
      edit: (field, value) => this.edit(field, value),
      save: () => { void this.save() },
      discard: () => this.discard(),
    }
  }
}
