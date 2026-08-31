/**
 * dsh-subagent-pause-xg 纯逻辑层单元测试（Node 内置 test runner）。
 * 运行：node --test tests/
 *
 * 测试对象为 lib/logic.js（tsc 构建产物），与 dsh-log-capture 同约定。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PauseTracker, matchesModelFilter, shouldPause, shouldAutoResumeGoal, isExternalInput } from '../lib/logic.js'

// ---------- PauseTracker：start / end 配对 ----------

test('start 登记后 hasActive / activeCount 生效', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(t.hasActive('parent-a'), true)
  assert.equal(t.activeCount('parent-a'), 1)
  assert.equal(t.hasActive('parent-b'), false)
  assert.equal(t.total(), 1)
})

test('end 按 runId 精确移除并返回记录，无匹配返回 undefined', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-2', 'parent-a', 'child-2')
  assert.deepEqual(t.end('run-1'), { runId: 'run-1', parentId: 'parent-a', childId: 'child-1' })
  assert.equal(t.hasActive('parent-a'), true) // 还有 run-2
  assert.equal(t.activeCount('parent-a'), 1)
  assert.equal(t.end('run-1'), undefined) // 已移除，无匹配
  assert.deepEqual(t.end('run-2'), { runId: 'run-2', parentId: 'parent-a', childId: 'child-2' })
  assert.equal(t.hasActive('parent-a'), false)
  assert.equal(t.total(), 0)
})

test('runId 重复 start 幂等（保留首次记录）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-1', 'parent-b', 'child-x') // 同一 runId 再次 start：忽略
  assert.equal(t.total(), 1)
  assert.equal(t.activeCount('parent-a'), 1)
  assert.equal(t.hasActive('parent-b'), false)
  // end 按首次登记的 parent 清理
  t.end('run-1')
  assert.equal(t.hasActive('parent-a'), false)
})

test('同一父会话多个子代理，全部结束后才放行', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-2', 'parent-a', 'child-2')
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), true)
  t.end('run-1')
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), true) // 仍有 run-2
  t.end('run-2')
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), false)
})

test('多父会话互不影响（子代理自身不被拦截）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), true) // 父会话：拦
  assert.equal(shouldPause(t, 'child-1', [], undefined, 'p', 'm'), false) // 子代理自己：不拦
  assert.equal(shouldPause(t, 'other', [], undefined, 'p', 'm'), false) // 无关会话：不拦
})

// ---------- PauseTracker：clearAgent ----------

test('clearAgent 清除父会话的全部活跃记录', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-2', 'parent-a', 'child-2')
  t.start('run-3', 'parent-b', 'child-3')
  assert.equal(t.clearAgent('parent-a'), 2)
  assert.equal(t.hasActive('parent-a'), false)
  assert.equal(t.hasActive('parent-b'), true)
  assert.equal(t.total(), 1)
})

test('clearAgent 清除子代理自身的 start 记录', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(t.clearAgent('child-1'), 1)
  assert.equal(t.hasActive('parent-a'), false)
  assert.equal(t.total(), 0)
})

test('clearAgent 无匹配返回 0', () => {
  const t = new PauseTracker()
  assert.equal(t.clearAgent('nobody'), 0)
})

// ---------- shouldPause：外部输入判定（v1.1.1 收紧） ----------

/** 构造带 source 的 claim 消息（结构投影，只关心 source） */
const msg = (kind, plugin) => ({ source: plugin === undefined ? { kind } : { kind, plugin } })

test('用户输入（kind user）→ 放行（人机交互优先，消息不丢）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('user')], undefined, 'p', 'm'), false)
})

test('子代理报告转达（subagent-report）→ 放行', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('subagent-report')], undefined, 'p', 'm'), false)
})

test('子代理结算通知（subagent-settled）→ 放行', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('subagent-settled')], undefined, 'p', 'm'), false)
})

test('后台任务完成通知（plugin tool-jobs）→ 放行（one-shot 子代理结果不丢）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'tool-jobs')], undefined, 'p', 'm'), false)
})

test('工具结果上下文（其他 plugin）→ 拦截（v1.1.1 核心变更）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'dsh-fs-edit')], undefined, 'p', 'm'), true)
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'dsh-fs-search')], undefined, 'p', 'm'), true)
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'dsh-compaction-basic')], undefined, 'p', 'm'), true)
})

test('goal 轮次 prompt（kind goal）→ 拦截（冻结期间 goal 回合不启动）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('goal')], undefined, 'p', 'm'), true)
})

test('混合批次：含任一外部输入即放行', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'dsh-fs-edit'), msg('user')], undefined, 'p', 'm'), false)
  assert.equal(shouldPause(t, 'parent-a', [msg('subagent-report'), msg('goal')], undefined, 'p', 'm'), false)
  assert.equal(shouldPause(t, 'parent-a', [msg('plugin', 'tool-jobs'), msg('goal')], undefined, 'p', 'm'), false)
})

test('无活跃子代理时即使无消息也放行', () => {
  const t = new PauseTracker()
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), false)
})

test('无消息空 step 且有活跃子代理 → 拦截', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [], undefined, 'p', 'm'), true)
})

test('isExternalInput：未知 kind / 无 source → false', () => {
  assert.equal(isExternalInput({}), false)
  assert.equal(isExternalInput({ source: { kind: 'system' } }), false)
  assert.equal(isExternalInput({ source: { kind: 'goal' } }), false)
  assert.equal(isExternalInput({ source: { kind: 'plugin', plugin: 'other' } }), false)
  assert.equal(isExternalInput({ source: null }), false)
  assert.equal(isExternalInput({ source: { kind: 'user' } }), true)
})

// ---------- shouldAutoResumeGoal（最后一个子代理结算后自动 resume） ----------

test('shouldAutoResumeGoal：仅 prompt-rejected 的 blocked goal 才自动 resume', () => {
  assert.equal(shouldAutoResumeGoal({ phase: 'blocked', blockedReason: { code: 'prompt-rejected' } }), true)
  // 其他 blocked 原因 / 其他 phase / 无 goal：一律不动
  assert.equal(shouldAutoResumeGoal({ phase: 'blocked', blockedReason: { code: 'round-limit' } }), false)
  assert.equal(shouldAutoResumeGoal({ phase: 'blocked', blockedReason: null }), false)
  assert.equal(shouldAutoResumeGoal({ phase: 'blocked' }), false)
  assert.equal(shouldAutoResumeGoal({ phase: 'active' }), false)
  assert.equal(shouldAutoResumeGoal({ phase: 'paused' }), false)
  assert.equal(shouldAutoResumeGoal({ phase: 'complete' }), false)
  assert.equal(shouldAutoResumeGoal(undefined), false)
  assert.equal(shouldAutoResumeGoal(null), false)
})

// ---------- matchesModelFilter ----------

test('filter 未配置 = 全部通配', () => {
  assert.equal(matchesModelFilter(undefined, 'llama-local', 'qwen'), true)
})

test('filter 为 null（yaml 空值）也视为未配置', () => {
  assert.equal(matchesModelFilter(null, 'llama-local', 'qwen'), true)
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [], null, 'llama-local', 'qwen'), true)
})

test('provider 精确匹配，其余 provider 不匹配', () => {
  const f = { provider: 'llama-local' }
  assert.equal(matchesModelFilter(f, 'llama-local', 'qwen'), true)
  assert.equal(matchesModelFilter(f, 'deepseek', 'qwen'), false)
})

test('model 精确匹配', () => {
  const f = { model: 'qwen2.5' }
  assert.equal(matchesModelFilter(f, 'llama-local', 'qwen2.5'), true)
  assert.equal(matchesModelFilter(f, 'llama-local', 'other'), false)
})

test('provider + model 同时匹配才通过', () => {
  const f = { provider: 'llama-local', model: 'qwen2.5' }
  assert.equal(matchesModelFilter(f, 'llama-local', 'qwen2.5'), true)
  assert.equal(matchesModelFilter(f, 'llama-local', 'other'), false)
  assert.equal(matchesModelFilter(f, 'deepseek', 'qwen2.5'), false)
})

// ---------- shouldPause：modelFilter 组合 ----------

test('modelFilter 不匹配时即使有活跃子代理也放行', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', [], { provider: 'deepseek' }, 'llama-local', 'qwen'), false)
  assert.equal(shouldPause(t, 'parent-a', [], { provider: 'llama-local' }, 'llama-local', 'qwen'), true)
})

// ---------- 快照 ----------

test('snapshot 返回全部活跃记录', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-2', 'parent-a', 'child-2')
  const snap = t.snapshot()
  assert.equal(snap.length, 2)
  assert.deepEqual(snap.map(r => r.runId).sort(), ['run-1', 'run-2'])
  assert.equal(snap[0].parentId, 'parent-a')
})
