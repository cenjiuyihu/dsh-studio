// dsh-studio — 「执行中」进度相关的纯函数测试。
//
// 覆盖 `src/protocol.js` 的 `summarizeToolCall`：把一次真实 `tool/call` 事件归纳成人类可读的一步。
// 样本用的是**实测到的原始形状**（`arguments` 是 JSON 字符串，不是对象），不是构造的理想输入。
//
// 用法：node test/progress.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeToolCall } from '../src/protocol.js'

test('edit：从 JSON 字符串里取出文件路径，只留末两级', () => {
  const raw = JSON.stringify({ file_path: 'C:\\work\\proj\\src\\tables\\lookup.cpp', old_string: 'a', new_string: 'b' })
  assert.deepEqual(summarizeToolCall('edit', raw), { kind: 'edit', label: '改 tables/lookup.cpp' })
})

test('write：同样按"改文件"归类', () => {
  const raw = JSON.stringify({ file_path: '/home/u/proj/out/report.md', content: 'x' })
  assert.deepEqual(summarizeToolCall('write', raw), { kind: 'edit', label: '改 out/report.md' })
})

test('read / grep：按"读"归类（grep 用 path 字段）', () => {
  assert.equal(summarizeToolCall('read', JSON.stringify({ file_path: 'D:\\a\\b\\client.js', limit: 40 })).kind, 'read')
  const grep = summarizeToolCall('grep', JSON.stringify({ path: 'D:\\a\\b\\client.js', pattern: 'foo' }))
  assert.equal(grep.kind, 'read')
  assert.equal(grep.label, '读 b/client.js')
})

test('pwsh：按"跑命令"归类，取命令首行并截断', () => {
  const raw = JSON.stringify({ command: 'cd D:\\DSH\nnpm test\n', timeoutMs: 1000 })
  const result = summarizeToolCall('pwsh', raw)
  assert.equal(result.kind, 'command')
  assert.equal(result.label, '跑命令：cd D:\\DSH')
  const long = summarizeToolCall('bash', JSON.stringify({ command: `echo ${'x'.repeat(200)}` }))
  assert.equal(long.kind, 'command')
  assert.equal(long.label.length <= 46, true, `过长命令必须截断：${long.label.length}`)
})

test('参数不是合法 JSON：如实归到"不可识别"，绝不编造文件名', () => {
  const result = summarizeToolCall('edit', '{不是合法 JSON')
  assert.equal(result.kind, 'edit')
  assert.equal(result.label, '改文件（edit）', '拿不到路径时只能说"改文件"，不能硬凑一个路径')
})

test('arguments 直接给对象也认（有些路径不做字符串化）', () => {
  assert.deepEqual(summarizeToolCall('edit', { file_path: 'x/y/z.ts' }), { kind: 'edit', label: '改 y/z.ts' })
})

test('未知工具：归类为 other，并把工具名带出来', () => {
  assert.deepEqual(summarizeToolCall('browser_eval', JSON.stringify({ expression: '1+1' })), {
    kind: 'other',
    label: '调用 browser_eval',
  })
  assert.deepEqual(summarizeToolCall('', ''), { kind: 'other', label: '调用了一个工具' })
})

test('缺失 name / 空 arguments 不抛错', () => {
  assert.doesNotThrow(() => summarizeToolCall(undefined, undefined))
  assert.equal(summarizeToolCall(undefined, undefined).kind, 'other')
})
