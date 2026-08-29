/**
 * dsh-subagent-pause-xg 纯逻辑层单元测试（Node 内置 test runner）。
 * 运行：node --test tests/
 *
 * 测试对象为 lib/logic.js（tsc 构建产物），与 dsh-log-capture 同约定。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PauseTracker, matchesModelFilter, shouldPause } from '../lib/logic.js'

// ---------- PauseTracker：start / end 配对 ----------

test('start 登记后 hasActive / activeCount 生效', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(t.hasActive('parent-a'), true)
  assert.equal(t.activeCount('parent-a'), 1)
  assert.equal(t.hasActive('parent-b'), false)
  assert.equal(t.total(), 1)
})

test('end 按 runId 精确移除，无匹配返回 false', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  t.start('run-2', 'parent-a', 'child-2')
  assert.equal(t.end('run-1'), true)
  assert.equal(t.hasActive('parent-a'), true) // 还有 run-2
  assert.equal(t.activeCount('parent-a'), 1)
  assert.equal(t.end('run-1'), false) // 已移除，无匹配
  assert.equal(t.end('run-2'), true)
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
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), true)
  t.end('run-1')
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), true) // 仍有 run-2
  t.end('run-2')
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), false)
})

test('多父会话互不影响（子代理自身不被拦截）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), true) // 父会话：拦
  assert.equal(shouldPause(t, 'child-1', 0, undefined, 'p', 'm'), false) // 子代理自己：不拦
  assert.equal(shouldPause(t, 'other', 0, undefined, 'p', 'm'), false) // 无关会话：不拦
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

// ---------- shouldPause：claimed 消息保护 ----------

test('有 claim 消息的 pre-step 一律放行（防消息丢失）', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', 1, undefined, 'p', 'm'), false) // 用户输入/通知/工具结果
  assert.equal(shouldPause(t, 'parent-a', 3, undefined, 'p', 'm'), false)
})

test('无 claim 消息且无活跃子代理 → 放行', () => {
  const t = new PauseTracker()
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), false)
})

test('无 claim 消息且有活跃子代理 → 拦截', () => {
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', 0, undefined, 'p', 'm'), true)
})

// ---------- matchesModelFilter ----------

test('filter 未配置 = 全部通配', () => {
  assert.equal(matchesModelFilter(undefined, 'llama-local', 'qwen'), true)
})

test('filter 为 null（yaml 空值）也视为未配置', () => {
  assert.equal(matchesModelFilter(null, 'llama-local', 'qwen'), true)
  const t = new PauseTracker()
  t.start('run-1', 'parent-a', 'child-1')
  assert.equal(shouldPause(t, 'parent-a', 0, null, 'llama-local', 'qwen'), true)
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
  assert.equal(shouldPause(t, 'parent-a', 0, { provider: 'deepseek' }, 'llama-local', 'qwen'), false)
  assert.equal(shouldPause(t, 'parent-a', 0, { provider: 'llama-local' }, 'llama-local', 'qwen'), true)
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
