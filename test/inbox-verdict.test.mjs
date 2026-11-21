// dsh-studio — `--inbox` 判定规则的单测（8 个分支全覆盖）。
//
// 为什么需要它：成员「示例甲」复验时**如实报告** ⚪「比我最早的发出记录还早 N 秒」
// 这条分支在真实会话里**无法触发**（账本只会越来越完整），它问"要不要给我个场景专测"。
// 靠构造真实历史去触发是不现实的 —— 所以把判定抽成纯函数，用单测把 8 个分支全钉住。
//
// 用法：node test/inbox-verdict.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { inboxVerdict } from '../src/protocol.js'

const base = {
  kind: 'deliver',
  isMember: true,
  replied: false,
  receiptKind: undefined,
  coverageStart: 1000, // 最早的发出记录（毫秒）
  at: 2000, // 这条消息晚于覆盖起点 → 在覆盖范围内
  hasEvidence: true,
  gapSeconds: 0,
}

const run = (patch) => inboxVerdict({ ...base, ...patch })

test('分支 1：非成员发送者 → 不判定（人转达的不算成员发的）', () => {
  const result = run({ isMember: false, replied: false })
  assert.equal(result.verdict, '⚪ 非成员发送者（人类在面板里转达的），不计入回复判定')
  assert.equal(result.debt, false, '非成员不该产生欠账')
})

test('分支 2：ask 且已有回执 → ✅ 已回执（带回执类型）', () => {
  assert.equal(run({ kind: 'ask', receiptKind: 'ack' }).verdict, '✅ 已回执（ack）')
  assert.equal(run({ kind: 'ask', receiptKind: 'decline' }).verdict, '✅ 已回执（decline）')
  assert.equal(run({ kind: 'ask', receiptKind: 'deliver' }).verdict, '✅ 已回执（deliver）')
  assert.equal(run({ kind: 'ask', receiptKind: 'progress' }).debt, false)
})

test('分支 3：ask 回过话但没有正式回执 → ⚠️ 欠回执（计一笔欠账）', () => {
  const result = run({ kind: 'ask', replied: true })
  assert.equal(result.verdict, '⚠️ 欠回执：回过话，但没给正式的接单/推掉回执')
  assert.equal(result.debt, true)
})

test('分支 4：非 ask 且回过话 → ✅ 之后我回过消息', () => {
  const result = run({ kind: 'deliver', replied: true })
  assert.equal(result.verdict, '✅ 之后我回过消息')
  assert.equal(result.debt, false)
})

test('分支 5：ask、在覆盖范围内、有证据、什么都没回 → ⚠️ 欠回执（计一笔欠账）', () => {
  const result = run({ kind: 'ask', replied: false })
  assert.equal(result.verdict, '⚠️ 欠回执：这条 ask 之后我什么都没回')
  assert.equal(result.debt, true)
})

test('分支 6：非 ask、在覆盖范围内、有证据、没回过 → 中性标记（**不是** ⚠️）', () => {
  const result = run({ kind: 'say', replied: false })
  assert.equal(result.verdict, '○ 未回过（非 ask，按礼节无需回执）')
  assert.equal(result.debt, false, '"没回过"不是欠账（只有 ask 才有回执义务）')
  assert.equal(result.verdict.includes('⚠️'), false, '★ ⚠️ 只允许出现在 ask 行上（成员「示例甲」5/5 反例）')
})

test('分支 6b：它是回复我某一条的 → 已闭环，不是欠账', () => {
  const result = run({ kind: 'deliver', replied: false, repliesToMine: 'c592f5' })
  assert.equal(result.verdict, '✅ 已闭环（它回的是我发的 #c592f5）')
  assert.equal(result.debt, false)
})

test('分支 7：有证据但消息早于覆盖起点 → ⚪ 无法判定（还早 N 秒）★ 真实场景无法触发的那条', () => {
  const result = run({ at: 500, coverageStart: 1000, hasEvidence: true, gapSeconds: 1 })
  assert.equal(result.verdict, '⚪ 无法判定（这条比我最早的发出记录还早 1 秒，没被覆盖，别据此重发）')
  assert.equal(result.debt, false, '无法判定绝不能算成欠账 —— 否则会误导成员重发')
})

test('分支 7b：gapSeconds 缺省时自己算出来（不传也要对）', () => {
  // 起点 1000、消息 400 → 差 600ms → round(0.6)=1 → 但代码取 max(1,...) 保证至少 1 秒
  const result = run({ at: 400, coverageStart: 1000, hasEvidence: true, gapSeconds: undefined })
  assert.match(result.verdict, /还早 \d+ 秒/)
})

test('分支 8：一条证据都没有 → ⚪ 无法判定（别据此重发）', () => {
  const result = run({ hasEvidence: false, coverageStart: Number.POSITIVE_INFINITY })
  assert.equal(result.verdict, '⚪ 无法判定（一条发出记录都没有，别据此重发）')
  assert.equal(result.debt, false)
})

test('边界：coverageStart 为 Infinity（无任何发出记录）时不误报 ⚠️', () => {
  const result = run({ coverageStart: Number.POSITIVE_INFINITY, hasEvidence: true, replied: false, kind: 'ask' })
  assert.equal(result.debt, false, '连起点都没有，就不能说"欠回执"')
  assert.match(result.verdict, /^⚪/)
})

test('边界：ask 的欠账与"已回执"互斥（有回执就绝不计欠账）', () => {
  const withReceipt = run({ kind: 'ask', receiptKind: 'deliver', replied: true })
  assert.equal(withReceipt.debt, false)
})
