// dsh-studio — S5 状态层：提审 / 批准 / 驳回（+ 执行进度引用）
//
// 设计要点（每条都对应一次真实故障）：
//
//  1. **状态放独立文件**（`$DSH_HOME/studio/reviews.json`），不塞进 `studio.json`
//     —— 避免与面板对工作室数据的写入互相覆盖。
//  2. **批准必须带 scope**（非空逐项列表）——
//     挡住"批准了 A、顺手做了 B"（规格 13.2 规则 1）。
//  3. **驳回必须带「理由 + 要改什么」** —— 否则执行方只能猜（规则 2）。
//  4. **scope 覆盖走"保守包含"** —— 已批准项必须**包含**待执行动作的文本才算覆盖；
//     判不准一律视为**未覆盖**（与"默认拒绝 > 默认选中"同一原则）。
//  5. **scope 不可变** —— 范围一变就必须**重新提审**，产生**新版本**，旧批准立即失效
//     （规格 13.1 #3：那次把"8 处"变成"90 处函数定义"、差点按旧口径做完）。
//  6. **过期即未批准** —— `expiresAt` 一到就按未批准处理；**读取时判定**，不起后台任务。
//
// 本模块是**纯逻辑 + 一个 JSON 文件**，不依赖宿主路由 —— 所以 CLI 期不需要重启主星。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 允许的相位。`expired` 只在"读取时判定"里出现，不会写进文件。 */
export const PHASES = ['submitted', 'approved', 'rejected', 'changes-requested']
export const REVIEWS_VERSION = 1

/** 数据文件位置：与工作室其它数据同目录（`$DSH_HOME/studio/`）。 */
export function resolveReviewsFile(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'studio', 'reviews.json')
}

/** 空账本。 */
export function emptyReviews() {
  return { unit: { name: 'studio-reviews', version: REVIEWS_VERSION }, tasks: {} }
}

/** 读账本；**容忍 BOM**（PowerShell 写出的 JSON 常带 BOM，会炸 `JSON.parse`）。 */
export function loadReviews(file) {
  if (!fs.existsSync(file)) return emptyReviews()
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  if (text.trim().length === 0) return emptyReviews()
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
    throw new Error(`reviews 文件形状不对：${file}`)
  }
  return parsed
}

/** 原子写（临时文件 + rename），避免半截文件。 */
export function saveReviews(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 归一化：用于 scope 覆盖判定（大小写 / 空白 / 全角逗号都不该影响判断）。 */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * 保守包含：已批准项必须**包含**待执行动作的文本。
 * - 相等 ⇒ 覆盖；
 * - `action` 是 `item` 的子串 ⇒ 覆盖（批准项是**更上位**的描述）；
 * - 其余 ⇒ **不覆盖**（含"批准项比动作更具体"这种最容易出事的反向情况）。
 */
export function scopeCovers(scopeItems, action) {
  const a = norm(action)
  if (a.length === 0) return false
  return (Array.isArray(scopeItems) ? scopeItems : []).some((item) => {
    const i = norm(item)
    return i.length > 0 && (i === a || a.includes(i))
  })
}

/** 有效相位：过期 ⇒ `expired`（等价于未批准），且**不改写文件**。 */
export function effectivePhase(review, now = Date.now()) {
  if (review === undefined || review === null) return undefined
  if (review.phase === 'approved' && typeof review.expiresAt === 'number' && review.expiresAt <= now) return 'expired'
  return review.phase
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}不能为空`)
  return value.trim()
}

function pushHistory(task, entry) {
  if (!Array.isArray(task.history)) task.history = []
  task.history.push(entry)
}

/**
 * 提审。**同一个 taskId 再次提审 = 新版本**；若 scope 与上一版不同，旧批准立即失效
 * （`scope 不可变`）。返回被写入的 task 对象。
 */
export function submit(data, { taskId, scope, by, at, evidence, expiresAt, note, repliesTo }) {
  const id = requireText(taskId, 'taskId')
  const scopes = (Array.isArray(scope) ? scope : [scope]).map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)
  if (scopes.length === 0) throw new Error('提审必须给 scope（逐项列出这次要批准什么）')
  const previous = data.tasks[id]
  const version = previous === undefined ? 1 : Number(previous.v ?? 1) + 1
  const task = {
    taskId: id,
    v: version,
    phase: 'submitted',
    scope: scopes,
    by: requireText(by, 'by'),
    at: at ?? new Date().toISOString(),
    evidence: Array.isArray(evidence) ? evidence : (evidence === undefined ? [] : [evidence]),
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    reason: null,
    changes: null,
    note: note ?? null,
    repliesTo: repliesTo ?? null,
    history: previous !== undefined && Array.isArray(previous.history) ? [...previous.history] : [],
  }
  pushHistory(task, { v: version, phase: 'submitted', by: task.by, at: task.at, scope: scopes, note: task.note })
  data.tasks[id] = task
  return task
}

/**
 * 决定：`approved` / `rejected` / `changes-requested`。
 * - approved 必须带 scope（可省略 ⇒ 视为沿用本条 scope；**显式空数组也不允许**）；
 * - rejected 必须带 `reason` **和** `changes`。
 */
export function decide(data, { taskId, phase, by, at, scope, reason, changes, evidence }) {
  const id = requireText(taskId, 'taskId')
  const task = data.tasks[id]
  if (task === undefined) throw new Error(`没有任务「${id}」，先提审`)
  if (!PHASES.includes(phase) || phase === 'submitted') throw new Error(`非法相位：${phase}`)
  const agent = requireText(by, 'by')
  const stamp = at ?? new Date().toISOString()

  if (phase === 'approved') {
    const scopes = scope === undefined
      ? task.scope
      : (Array.isArray(scope) ? scope : [scope]).map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new Error('批准必须带 scope（逐项列出这次批准了什么）—— 挡住"批准了 A、顺手做了 B"')
    }
    task.scope = scopes
    task.reason = null
    task.changes = null
  } else {
    task.reason = requireText(reason, '驳回/要求修改必须给理由')
    task.changes = requireText(changes, '驳回/要求修改必须写明"要改什么"')
  }
  task.phase = phase
  task.by = agent
  task.at = stamp
  if (evidence !== undefined) {
    task.evidence = [...(Array.isArray(task.evidence) ? task.evidence : []), ...(Array.isArray(evidence) ? evidence : [evidence])]
  }
  pushHistory(task, { v: task.v, phase, by: agent, at: stamp, scope: task.scope, reason: task.reason, changes: task.changes })
  return task
}

/**
 * 闸门：**不可逆操作只认批准态**（规则 3）。
 * 返回 `{ ok, why, task }`；`ok !== true` 时调用方必须**拒绝执行**。
 */
export function checkGate(data, { taskId, action, now = Date.now() }) {
  const task = data.tasks[String(taskId ?? '').trim()]
  if (task === undefined) return { ok: false, why: `没有任务「${taskId}」—— 不可逆操作前必须先提审`, task: undefined }
  const phase = effectivePhase(task, now)
  if (phase !== 'approved') {
    const why = phase === 'expired'
      ? `批准已于 ${new Date(task.expiresAt).toISOString()} 过期 ⇒ 视为未批准`
      : `当前相位是「${phase}」，不是 approved`
    return { ok: false, why, task }
  }
  if (!scopeCovers(task.scope, action)) {
    return {
      ok: false,
      why: `已批准的 scope 不覆盖该动作「${action}」\n已批准项：${task.scope.map((s) => `「${s}」`).join('、')}\n⇒ 要么改动作、要么重新提审`,
      task,
    }
  }
  return { ok: true, why: `被第 v${task.v} 版批准的第 ${task.scope.findIndex((s) => norm(action).includes(norm(s)) || norm(s) === norm(action)) + 1} 项覆盖`, task }
}

/** 人类可读的单条摘要。 */
export function formatReview(task, now = Date.now()) {
  if (task === undefined) return '（没有这条任务）'
  const phase = effectivePhase(task, now)
  const lines = [
    `任务 ${task.taskId}  v${task.v}  phase=${phase}${phase !== task.phase ? `（原为 ${task.phase}）` : ''}`,
    `  提交：${task.by} @ ${task.at}`,
    `  scope：${task.scope.map((s) => `「${s}」`).join('、')}`,
  ]
  if (task.expiresAt !== null) lines.push(`  过期：${new Date(task.expiresAt).toISOString()}`)
  if (task.reason !== null) lines.push(`  理由：${task.reason}`)
  if (task.changes !== null) lines.push(`  要改什么：${task.changes}`)
  if (Array.isArray(task.evidence) && task.evidence.length > 0) lines.push(`  证据：${task.evidence.join('、')}`)
  return lines.join('\n')
}
