/**
 * dsh-subagent-pause-xg 客户端半：在设置页「可配置插件」tab 注册
 * 'subagent-pause' 卡片（settings.plugin.item keyed slot）。
 *
 * 参照 dsh-token-stats 的客户端模式：结构性类型（不 import 客户端运行时包）、
 * 内联 CSS（主题 token，浅色/深色自适应）、react external（模块表注入）。
 *
 * 卡片数据面：settings scope（namespace 'subagent-pause'，宿主半经
 * settings.installSection 注册）；写路径为 scope.set/unset → settings.mutate，
 * 保存即 live 生效（无需重启）。
 */

import { PauseCardController } from './controller.ts'
import { PauseSettingsCard } from './PauseSettingsCard.tsx'

/** 结构性 slots 服务面（与运行时 SlotRegistry 一致；仅取本插件用到的方法） */
type SlotsService = {
  inject(key: string, callback: () => void | (() => void)): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 结构性 settingsScope 服务面（ui-settings 提供；bind 返回 SettingsScope 契约） */
type SettingsScopeService = {
  bind<T>(spec: { namespace: string }): {
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
}

/** 结构性客户端根上下文面（仅取本插件用到的字段） */
type ClientContext = {
  slots: SlotsService
  settingsScope: SettingsScopeService
  effect(dispose: () => void, label?: string): void
}

/** settings.plugin.item 的 key = 宿主 settings namespace */
const SETTINGS_NAMESPACE = 'subagent-pause'

const STYLES = `
.spc-card { list-style: none; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04)); overflow: hidden; }
.spc-card * { box-sizing: border-box; }
.spc-header { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 14px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; font: inherit; }
.spc-header:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }
.spc-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.spc-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #ffffff); }
.spc-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.55)); }
.spc-pending { font-size: 11px; color: var(--dsw-alias-brand-primary, #ff7a1a); white-space: nowrap; }
.spc-chevron { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.55)); transition: transform 0.15s ease; }
.spc-chevron-open { transform: rotate(180deg); }
.spc-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 14px 14px; }
.spc-readonly { margin: 0; font-size: 12px; color: var(--dsw-alias-state-warning-primary, #f0b429); }
.spc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.spc-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.spc-check input { margin-top: 2px; accent-color: var(--dsw-alias-brand-primary, #ff7a1a); }
.spc-check-text { display: flex; flex-direction: column; gap: 2px; }
.spc-label { font-size: 12px; color: var(--dsw-alias-label-primary, #ffffff); }
.spc-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.45)); }
.spc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 720px) { .spc-grid { grid-template-columns: 1fr; } }
.spc-input { width: 100%; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-primary, #ffffff); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1)); border-radius: 6px; outline: none; }
.spc-input:focus { border-color: var(--dsw-alias-brand-primary, #ff7a1a); }
.spc-input::placeholder { color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.35)); }
.spc-input:disabled { opacity: 0.55; }
.spc-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.spc-failed { margin: 0 auto 0 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #ff5c5c); }
.spc-discard, .spc-save { padding: 5px 14px; font-size: 12px; border-radius: 6px; cursor: pointer; font: inherit; }
.spc-discard { color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.7)); background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.15)); }
.spc-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #ffffff); }
.spc-save { color: #ffffff; background: var(--dsw-alias-brand-primary, #ff7a1a); border: 1px solid transparent; }
.spc-save:hover:not(:disabled) { filter: brightness(1.1); }
.spc-discard:disabled, .spc-save:disabled { opacity: 0.5; cursor: default; }
`

function installStyles(): void {
  const tagId = 'dsh-subagent-pause-xg'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-subagent-pause-xg'
    tag.dataset.pluginCss = tagId
    tag.textContent = STYLES
    document.head.appendChild(tag)
  }
}

/** 硬依赖：slots 与 settingsScope 服务就绪后 fiber 才执行 apply */
export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'subagent-pause:styles')
  const controller = new PauseCardController(ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE }))
  ctx.effect(() => () => { controller.dispose() }, 'subagent-pause:controller')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NAMESPACE,
    inject: () => controller.inject(),
  }, PauseSettingsCard))
}
