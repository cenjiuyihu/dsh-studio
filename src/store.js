// dsh-studio — 工作室自有数据（成员 / 群）。
//
// 纪律：本文件只读写 dsh工作室自己的数据文件，**绝不触碰任何会话日志、workspace 域或 settings**。
// 所有"关于会话的元数据"（别名、颜色、角色、能力标签、锁定、置顶）都只活在这里，
// 会话本身因此完全不被修改 —— 这是"提升为成员"能做到零侵入的原因。
//
// 纯函数（normalizeState / memberAdd / memberUpdate / memberRemove / sortedMembers）与
// 文件 IO（StudioStore）分开，前者由 test/store.test.mjs 直接单测。

import fs from 'node:fs'
import path from 'node:path'

/** 数据文件格式版本；未来改结构时用它做迁移判断。 */
export const STUDIO_VERSION = 1
/** v1 只有一个群；结构上预留多个（groups 是 map）。 */
export const DEFAULT_GROUP_ID = 'main'
export const DEFAULT_GROUP_NAME = '我的工作室'

const MAX_SHORT = 120
const MAX_NOTE = 400
const MAX_CAP = 40
const MAX_CAPS = 12

function str(value, max = MAX_SHORT) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function int(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function uniqueStrings(value, maxLength, limit) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = str(item, maxLength)
    if (text.length === 0 || out.includes(text)) continue
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** 一个干净的空状态。 */
export function emptyState(now = new Date().toISOString()) {
  return {
    version: STUDIO_VERSION,
    activeGroupId: DEFAULT_GROUP_ID,
    members: {},
    groups: {
      [DEFAULT_GROUP_ID]: {
        groupId: DEFAULT_GROUP_ID,
        name: DEFAULT_GROUP_NAME,
        memberIds: [],
        createdAt: now,
      },
    },
  }
}

/** 一个成员记录的默认值。新成员**默认锁定**（归档在 DSH 里不可逆，见 README）。 */
export function newMember(sessionId, input = {}, now = new Date().toISOString(), order = 0) {
  return {
    sessionId,
    alias: str(input.alias),
    color: str(input.color, 32),
    role: str(input.role),
    caps: uniqueStrings(input.caps, MAX_CAP, MAX_CAPS),
    locked: bool(input.locked, true),
    pinned: bool(input.pinned, false),
    order: int(input.order, order),
    addedAt: now,
    note: str(input.note, MAX_NOTE),
  }
}

/**
 * v1 的群成员 = 全部成员。多群预留：其它 group 记录原样保留，只有默认群被同步。
 */
export function syncDefaultGroup(state) {
  const ids = Object.keys(state.members).sort((a, b) => state.members[a].order - state.members[b].order)
  const existing = state.groups[DEFAULT_GROUP_ID]
  state.groups[DEFAULT_GROUP_ID] = {
    groupId: DEFAULT_GROUP_ID,
    name: existing !== undefined && existing.name.length > 0 ? existing.name : DEFAULT_GROUP_NAME,
    memberIds: ids,
    createdAt: existing !== undefined && existing.createdAt.length > 0 ? existing.createdAt : new Date().toISOString(),
  }
  return state
}

/**
 * 把磁盘上读到的任意内容收敛成合法状态：坏字段一律丢弃，**不抛异常**。
 * 这让手改文件 / 旧版本残留都不会让插件起不来。
 */
export function normalizeState(raw, now = new Date().toISOString()) {
  const state = emptyState(now)
  if (raw === null || typeof raw !== 'object') return state

  const activeGroupId = str(raw.activeGroupId, 64)
  if (activeGroupId.length > 0) state.activeGroupId = activeGroupId

  const rawMembers = raw.members !== null && typeof raw.members === 'object' ? raw.members : {}
  for (const [key, value] of Object.entries(rawMembers)) {
    if (value === null || typeof value !== 'object') continue
    const sessionId = str(value.sessionId, 200) || str(key, 200)
    if (sessionId.length === 0) continue
    state.members[sessionId] = newMember(sessionId, value, now, int(value.order, 0))
    state.members[sessionId].addedAt = str(value.addedAt, 40) || now
  }

  const rawGroups = raw.groups !== null && typeof raw.groups === 'object' ? raw.groups : {}
  for (const [key, value] of Object.entries(rawGroups)) {
    if (value === null || typeof value !== 'object') continue
    const groupId = str(value.groupId, 64) || str(key, 64)
    if (groupId.length === 0) continue
    state.groups[groupId] = {
      groupId,
      name: str(value.name, 64) || groupId,
      memberIds: uniqueStrings(value.memberIds, 200, 500),
      createdAt: str(value.createdAt, 40) || now,
    }
  }

  return syncDefaultGroup(state)
}

/** 下一个可用的排序号（永远追加到末尾）。 */
export function nextOrder(state) {
  let max = 0
  for (const member of Object.values(state.members)) if (member.order > max) max = member.order
  return max + 1
}

/** 提升为成员 / 更新已有成员。返回 { state, member, created }（不改原对象）。 */
export function memberUpsert(state, input, now = new Date().toISOString()) {
  const sessionId = str(input.sessionId, 200)
  if (sessionId.length === 0) throw new Error('member/upsert 需要 sessionId')
  const existing = state.members[sessionId]
  const next = {
    ...state,
    members: { ...state.members },
  }
  if (existing === undefined) {
    next.members[sessionId] = newMember(sessionId, input, now, nextOrder(state))
    syncDefaultGroup(next)
    return { state: next, member: next.members[sessionId], created: true }
  }
  const merged = { ...existing }
  if (input.alias !== undefined) merged.alias = str(input.alias)
  if (input.color !== undefined) merged.color = str(input.color, 32)
  if (input.role !== undefined) merged.role = str(input.role)
  if (input.caps !== undefined) merged.caps = uniqueStrings(input.caps, MAX_CAP, MAX_CAPS)
  if (input.locked !== undefined) merged.locked = bool(input.locked, merged.locked)
  if (input.pinned !== undefined) merged.pinned = bool(input.pinned, merged.pinned)
  if (input.note !== undefined) merged.note = str(input.note, MAX_NOTE)
  if (input.order !== undefined) merged.order = int(input.order, merged.order)
  next.members[sessionId] = merged
  syncDefaultGroup(next)
  return { state: next, member: merged, created: false }
}

/** 从工作室移除成员（**只移除登记，不动会话本身**）。 */
export function memberRemove(state, sessionId) {
  const id = str(sessionId, 200)
  if (state.members[id] === undefined) return { state, removed: false }
  const members = { ...state.members }
  delete members[id]
  const next = { ...state, members }
  syncDefaultGroup(next)
  return { state: next, removed: true }
}

/** 面板展示顺序：置顶在前，其次按 order 升序。 */
export function sortedMembers(state) {
  return Object.values(state.members).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.order !== b.order) return a.order - b.order
    return a.sessionId.localeCompare(b.sessionId)
  })
}

/** 该会话是否被锁定（锁定成员禁止归档）。 */
export function isLocked(state, sessionId) {
  const member = state.members[str(sessionId, 200)]
  return member !== undefined && member.locked === true
}

/** 磁盘存储：单写者（宿主半边），原子写（临时文件 + rename）。 */
export class StudioStore {
  constructor(file) {
    this.file = file
    this.state = emptyState()
    this.loaded = false
    /** 读取失败原因（诊断用，不阻塞插件运行）。 */
    this.loadError = undefined
    this.savedAt = undefined
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      // ★ 去掉 UTF-8 BOM：PowerShell 的 `Set-Content -Encoding UTF8`（以及很多 Windows 工具）
      //   会在文件头写 U+FEFF，而 `JSON.parse` **不认**它 —— 报的是"位置 0 的意外字符"，
      //   看起来像文件坏了，其实只差三个字节。成员「维护者」今天实测踩到（它给三个控制文件加了容错），
      //   而本文件同样是"可能被外部工具写过"的 JSON，所以这里一并加固。
      this.state = normalizeState(JSON.parse(text.replace(/^\uFEFF/, '')))
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') this.loadError = error instanceof Error ? error.message : String(error)
      this.state = emptyState()
    }
    this.loaded = true
    return this.state
  }

  /** 原子落盘：同目录临时文件写完后 rename 覆盖。 */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
    this.savedAt = new Date().toISOString()
  }

  /** 改状态的唯一入口：变异 → 落盘 → 返回结果。落盘失败会抛（调用方转成 RPC 错误）。 */
  mutate(reducer) {
    const result = reducer(this.state)
    this.state = result.state
    this.save()
    return result
  }

  upsert(input) {
    return this.mutate((state) => memberUpsert(state, input))
  }

  remove(sessionId) {
    return this.mutate((state) => memberRemove(state, sessionId))
  }

  members() {
    return sortedMembers(this.state)
  }

  isLocked(sessionId) {
    return isLocked(this.state, sessionId)
  }
}
