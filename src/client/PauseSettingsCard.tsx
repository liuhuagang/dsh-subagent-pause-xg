/**
 * dsh-subagent-pause-xg 设置卡片（settings.plugin.item，key 'subagent-pause'）。
 *
 * 与 shell/agent-loop/web-search 三张官方卡片同构：折叠 header + 字段表单 +
 * 保存/放弃。样式走 DSH 主题 token（--dsw-alias-*），浅色/深色自适应；
 * 文案中文硬编码（本仓库工作语言，不引入 locale 服务）。
 */

import { useEffect, useState } from 'react'
import type { PauseCardFace, PauseCardState, PauseField } from './controller.ts'

/** 折叠卡片 */
export function PauseSettingsCard(props: PauseCardFace) {
  const [state, setState] = useState<PauseCardState>(() => props.getState())
  const [open, setOpen] = useState(false)
  useEffect(() => props.subscribe(() => setState(props.getState())), [props])

  // namespace 未由宿主注册（宿主插件未加载/未重启）→ 不渲染任何痕迹
  if (!state.available) return null
  const { draft, dirty, saving, failed, writable } = state
  const blocked = !dirty || saving

  return (
    <li className="spc-card">
      <button
        type="button"
        className="spc-header"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className="spc-head-text">
          <span className="spc-name">子代理暂停（subagent-pause）</span>
          <span className="spc-desc">父会话有活跃子代理时暂停其回合，报告送达自动恢复</span>
        </span>
        {dirty ? <span className="spc-pending">未保存</span> : null}
        <span className={open ? 'spc-chevron spc-chevron-open' : 'spc-chevron'}>▾</span>
      </button>
      {open
        ? (
          <div className="spc-body">
            {!writable ? <p className="spc-readonly" role="status">设置文档只读，无法保存</p> : null}
            <div className="spc-field">
              <label className="spc-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={!writable}
                  onChange={(event) => { props.edit('enabled', event.target.checked) }}
                />
                <span className="spc-check-text">
                  <span className="spc-label">启用暂停</span>
                  <span className="spc-hint">关闭后父会话在子代理活跃期间正常继续回合；保存即生效，无需重启</span>
                </span>
              </label>
            </div>
            <div className="spc-field">
              <label className="spc-check">
                <input
                  type="checkbox"
                  checked={draft.verbose}
                  disabled={!writable}
                  onChange={(event) => { props.edit('verbose', event.target.checked) }}
                />
                <span className="spc-check-text">
                  <span className="spc-label">详细日志</span>
                  <span className="spc-hint">每条子代理 start/end 与回合 blocked 都输出双通道日志</span>
                </span>
              </label>
            </div>
            <div className="spc-grid">
              <div className="spc-field">
                <label className="spc-label" htmlFor="spc-provider">Provider 过滤（可选）</label>
                <input
                  id="spc-provider"
                  className="spc-input"
                  type="text"
                  placeholder="如 llama-local，留空 = 全部"
                  value={draft.provider}
                  disabled={!writable}
                  onChange={(event) => { props.edit('provider', event.target.value) }}
                />
              </div>
              <div className="spc-field">
                <label className="spc-label" htmlFor="spc-model">Model 过滤（可选）</label>
                <input
                  id="spc-model"
                  className="spc-input"
                  type="text"
                  placeholder="留空 = 全部"
                  value={draft.model}
                  disabled={!writable}
                  onChange={(event) => { props.edit('model', event.target.value) }}
                />
              </div>
            </div>
            <div className="spc-footer">
              {failed ? <p className="spc-failed" role="status">保存失败，请重试</p> : null}
              <button
                type="button"
                className="spc-discard"
                disabled={blocked}
                onClick={() => { props.discard() }}
              >
                放弃
              </button>
              <button
                type="button"
                className="spc-save"
                disabled={blocked}
                onClick={() => { props.save() }}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

export type { PauseField }
