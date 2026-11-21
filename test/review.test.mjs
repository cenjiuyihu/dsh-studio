// S5 状态层的单测。每条断言都对应规格 §13 里的一条规则 —— 规则被破坏时这里必须先红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PHASES, checkGate, decide, effectivePhase, emptyReviews, formatReview,
  loadReviews, resolveReviewsFile, saveReviews, scopeCovers, submit,
} from '../src/review.js'

const at = (s) => `2026-09-22T00:00:${String(s).padStart(2, '0')}.000Z`

// ── 规则 1：提审/批准都必须带 scope ───────────────────────────────────────────
test('提审必须带 scope（空/全空白都不行）', () => {
  const d = emptyReviews()
  assert.throws(() => submit(d, { taskId: 'T1', scope: [], by: '示例乙' }), /scope/)
  assert.throws(() => submit(d, { taskId: 'T1', scope: ['  ', ''], by: '示例乙' }), /scope/)
  const t = submit(d, { taskId: 'T1', scope: ['改 a.cpp 的编译错误'], by: '示例乙', at: at(1) })
  assert.equal(t.v, 1)
  assert.equal(t.phase, 'submitted')
})

test('批准必须带 scope —— 显式空数组也要被拒（"批准了 A、顺手做了 B" 的入口）', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['改 a.cpp'], by: '示例乙', at: at(1) })
  assert.throws(() => decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', scope: [], at: at(2) }), /scope/)
  // 省略 scope ⇒ 沿用提审时的 scope（允许）
  const t = decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(2) })
  assert.equal(t.phase, 'approved')
  assert.deepEqual(t.scope, ['改 a.cpp'])
})

// ── 规则 2：驳回必须带「理由 + 要改什么」────────────────────────────────────
test('驳回必须同时给理由和"要改什么"', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['改 a.cpp'], by: '示例乙', at: at(1) })
  assert.throws(() => decide(d, { taskId: 'T1', phase: 'rejected', by: '示例甲', reason: '不行', at: at(2) }), /要改什么/)
  assert.throws(() => decide(d, { taskId: 'T1', phase: 'rejected', by: '示例甲', changes: '改注释', at: at(2) }), /理由/)
  const t = decide(d, { taskId: 'T1', phase: 'changes-requested', by: '示例甲', reason: '块注释没剥离', changes: '剥掉块注释再跑', at: at(2) })
  assert.equal(t.phase, 'changes-requested')
  assert.equal(t.reason, '块注释没剥离')
})

// ── 规则 4：scope 覆盖是"保守包含" ──────────────────────────────────────────
test('scopeCovers：相等覆盖；更上位的批准项覆盖更具体的动作；**反向不覆盖**', () => {
  assert.equal(scopeCovers(['改 X 文件'], '改 X 文件'), true)
  assert.equal(scopeCovers(['改 X 文件'], '改 X 文件第 3 行'), true, '批准项是更上位的描述 ⇒ 覆盖')
  assert.equal(scopeCovers(['改 X 文件第 3 行'], '改 X 文件'), false, '批准项比动作更具体 ⇒ 不覆盖（最危险的反向）')
  assert.equal(scopeCovers(['改 X 文件'], ''), false)
  assert.equal(scopeCovers([], '改 X 文件'), false)
  assert.equal(scopeCovers([' 改   X 文件 '], '改 x 文件'), true, '空白/大小写不影响判定')
})

// ── 规则 3：不可逆操作只认批准态 ───────────────────────────────────────────
test('闸门：未提审/未批准/不覆盖 三种情况都拒；覆盖才放行', () => {
  const d = emptyReviews()
  assert.equal(checkGate(d, { taskId: 'T1', action: '落盘 a.cpp' }).ok, false, '没提审 ⇒ 拒')

  submit(d, { taskId: 'T1', scope: ['改 a.cpp 的编译错误'], by: '示例乙', at: at(1) })
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 a.cpp 的编译错误' }).ok, false, '只是 submitted ⇒ 拒')

  decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(2) })
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 a.cpp 的编译错误' }).ok, true, '已批准且逐字覆盖 ⇒ 放行')
  assert.equal(
    checkGate(d, { taskId: 'T1', action: '改 a.cpp 的编译错误（第 3 行）' }).ok,
    true,
    '动作是批准项的【更具体】形式 ⇒ 覆盖（批准项更上位）',
  )
  assert.equal(checkGate(d, { taskId: 'T1', action: '落盘 a.cpp' }).ok, false, '**换了动词就不覆盖** —— 批准的是"改"不是"落盘"')
  const bad = checkGate(d, { taskId: 'T1', action: '顺手把 b.java 也改了' })
  assert.equal(bad.ok, false, '超出 scope ⇒ 拒')
  assert.match(bad.why, /不覆盖/)
})

// ── 规则 6：过期即未批准（读取时判定，不写文件）─────────────────────────────
test('过期 ⇒ expired ⇒ 闸门拒；且不改写文件里的 phase', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['改 a.cpp'], by: '示例乙', at: at(1), expiresAt: 1000 })
  decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(2) })
  const task = d.tasks.T1
  assert.equal(effectivePhase(task, 999), 'approved')
  assert.equal(effectivePhase(task, 2000), 'expired')
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 a.cpp', now: 2000 }).ok, false)
  assert.equal(task.phase, 'approved', '判定是读取时的，不改写文件')
})

// ── 规则 5：scope 不可变 ⇒ 重新提审 = 新版本 + 旧批准失效 ───────────────────
test('范围一变就必须重新提审：版本 +1，旧批准立即失效', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['改 8 处编译错误'], by: '示例乙', at: at(1) })
  decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(2) })
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 8 处编译错误' }).ok, true)

  // 范围变成 90 处 ⇒ 必须重新提审
  const t2 = submit(d, { taskId: 'T1', scope: ['改 90 处函数定义'], by: '示例乙', at: at(3) })
  assert.equal(t2.v, 2)
  assert.equal(t2.phase, 'submitted', '新版本回到 submitted')
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 8 处编译错误' }).ok, false, '旧批准立即失效')
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 90 处函数定义' }).ok, false, '新版本还没批')
  decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(4) })
  assert.equal(checkGate(d, { taskId: 'T1', action: '改 90 处函数定义' }).ok, true)
})

test('历史保留：每次提交与决定都进 history', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['a'], by: '示例乙', at: at(1) })
  decide(d, { taskId: 'T1', phase: 'changes-requested', by: '示例甲', reason: 'r', changes: 'c', at: at(2) })
  submit(d, { taskId: 'T1', scope: ['a', 'b'], by: '示例乙', at: at(3) })
  const kinds = d.tasks.T1.history.map((h) => `${h.v}:${h.phase}`)
  assert.deepEqual(kinds, ['1:submitted', '1:changes-requested', '2:submitted'])
})

// ── 落盘：位置、BOM 容忍、原子写 ────────────────────────────────────────────
test('数据文件位置由 DSH_HOME 决定', () => {
  assert.equal(resolveReviewsFile({ DSH_HOME: 'C:\\x' }), path.join('C:\\x', 'studio', 'reviews.json'))
})

test('容忍 BOM（PowerShell 写出的 JSON 常带 BOM）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-review-'))
  const file = path.join(dir, 'reviews.json')
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(emptyReviews())}`, 'utf8')
  assert.deepEqual(loadReviews(file).tasks, {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('存取往返一致，且没有残留 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-review-'))
  const file = path.join(dir, 'reviews.json')
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['改 a.cpp'], by: '示例乙', at: at(1) })
  saveReviews(file, d)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  assert.deepEqual(loadReviews(file).tasks.T1.scope, ['改 a.cpp'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('formatReview 能把"过期"显示出来（原相位与实际相位不一致时标注）', () => {
  const d = emptyReviews()
  submit(d, { taskId: 'T1', scope: ['x'], by: '示例乙', at: at(1), expiresAt: 1000 })
  decide(d, { taskId: 'T1', phase: 'approved', by: '示例甲', at: at(2) })
  assert.match(formatReview(d.tasks.T1, 2000), /phase=expired（原为 approved）/)
  assert.ok(PHASES.includes('approved'))
})
