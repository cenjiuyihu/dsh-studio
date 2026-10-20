// dsh-studio — 宿主半边（dsh工作室）。
//
// 职责只有四件，都不碰任何会话的内容：
//   1. 持有工作室自有数据文件（$DSH_HOME/studio/studio.json）——成员与群；
//   2. 提供受信任围栏保护的 JSON 路由 /api/dsh-studio/*（浏览器半边通过 fetch 读写）；
//   3. S2「锁定」：包装 workspaceRegistry.archiveSession，锁定成员禁止归档（这一层是权威层，
//      保护所有窗口/所有客户端；客户端半边另有一层给可见反馈，因为产品自己只 console.warn）；
//   4. 诊断信息（数据文件路径、读取错误、拦截记录），供面板显示。
//
// 明确的"不做"：不写会话日志、不调 session.rename/prompt、不动 workspace 域的归档集合之外的东西、
// 不注册任何模型工具、不 provide 任何服务。卸载时全部还原（见 ctx.effect）。

import os from 'node:os'
import path from 'node:path'
import { StudioStore } from './store.js'

export const name = 'dsh-studio'
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-studio'
const MAX_INTERCEPTS = 20

/** 工作室数据文件：$DSH_HOME/studio/studio.json。 */
function resolveStoreFile() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(home, 'studio', 'studio.json')
}

/** 会话 id 的短形式，用于给人类看的信息里代替一长串 uuid。 */
function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  const bare = text.startsWith('session-') ? text.slice(8) : text
  return bare.slice(0, 8)
}

/** 从一个会话记录里尽最大努力读出 id（字段拼写在不同服务上不完全一致，一律容错）。 */
function recordId(record) {
  if (record === null || typeof record !== 'object') return undefined
  for (const key of ['sessionId', 'id', 'sessionID']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const header = record.header
  if (header !== null && typeof header === 'object' && typeof header.id === 'string') return header.id
  return undefined
}

/** 该 sessionId 是否真实存在（live 优先，其次持久层）。存在性校验只发生在"提升为成员"时。 */
async function sessionExists(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== void 0 && typeof sessions.get === 'function' && sessions.get(sessionId) !== void 0) return true
  const query = ctx.get('sessionQuery')
  if (query !== void 0 && typeof query.listSessions === 'function') {
    try {
      const list = await query.listSessions()
      if (Array.isArray(list) && list.some((entry) => recordId(entry) === sessionId)) return true
    } catch {
      /* 落到持久层再试 */
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== void 0 && typeof persistence.list === 'function') {
    try {
      const headers = await persistence.list()
      if (Array.isArray(headers) && headers.some((entry) => recordId(entry) === sessionId)) return true
    } catch {
      /* 确认不了就当它不存在 */
    }
  }
  return false
}

/**
 * S2 的权威锁：包装 workspaceRegistry.archiveSession。
 * 调用点在 dsh-host-apiproxy：`await ctx.workspaceRegistry.archiveSession(sessionId)`（调用时属性查找），
 * 所以实例级遮蔽有效。卸载时只在"当前位置仍是我的包装"时还原。
 */
function installArchiveLock(ctx, store, intercepts, log) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === void 0 || typeof registry.archiveSession !== 'function') {
    return { installed: false, reason: 'workspaceRegistry.archiveSession 不可用', dispose: () => {} }
  }
  const original = registry.archiveSession
  const wrapped = function (sessionId) {
    try {
      const member = store.state.members[sessionId]
      if (member !== undefined && member.locked === true) {
        const label = member.alias.length > 0 ? member.alias : shortSessionId(sessionId)
        intercepts.push({
          at: new Date().toISOString(),
          sessionId: String(sessionId),
          action: 'archive-refused',
          label,
        })
        if (intercepts.length > MAX_INTERCEPTS) intercepts.splice(0, intercepts.length - MAX_INTERCEPTS)
        log(`blocked archive of locked member "${label}"`)
        return Promise.reject(
          new Error(
            `【dsh工作室】「${label}」已锁定为成员，归档被阻止。如需归档，请先在工作室面板解锁。`,
          ),
        )
      }
    } catch (error) {
      // 锁检查本身出错时绝不阻断原行为（宁可漏锁，不可误伤）。
      log(`lock check failed, passing through: ${String(error)}`)
    }
    return original.apply(this, arguments)
  }
  wrapped.__dshStudioLock = true
  registry.archiveSession = wrapped

  const proto = Object.getPrototypeOf(registry)
  const dispose = () => {
    if (registry.archiveSession !== wrapped) return
    if (proto !== null && proto.archiveSession === original) delete registry.archiveSession
    else registry.archiveSession = original
  }
  return { installed: true, reason: undefined, dispose }
}

export function apply(ctx) {
  const log = (message) => {
    const line = `[dsh-studio] ${message}`
    if (ctx.logger !== void 0 && typeof ctx.logger.info === 'function') ctx.logger.info(line)
    else console.log(line)
  }

  const store = new StudioStore(resolveStoreFile())
  store.load()
  if (store.loadError !== void 0) log(`data file unreadable, starting from empty state: ${store.loadError}`)

  /** 拦截记录（内存，不持久化；纯诊断）。 */
  const intercepts = []
  const lock = installArchiveLock(ctx, store, intercepts, log)
  if (!lock.installed) log(`archive lock unavailable: ${lock.reason}`)
  ctx.effect(() => () => lock.dispose(), 'dsh-studio: archiveSession lock')

  const publicState = () => ({
    version: store.state.version,
    activeGroupId: store.state.activeGroupId,
    members: store.members(),
    groups: Object.values(store.state.groups),
    file: store.file,
    loadError: store.loadError,
    savedAt: store.savedAt,
    lock: { installed: lock.installed, reason: lock.reason, intercepts: [...intercepts] },
  })

  const webServer = ctx.get('webServer')
  if (webServer === void 0) {
    log('webServer absent — the panel cannot talk to the host half')
    return
  }

  // 信任围栏与 /api 网关一致：仅回环与可信任主机可访问（照抄已跑通的 dsh-composer-send-key）。
  const fence = (req) => {
    const host = String(req.headers.host ?? '').split(':')[0]
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
    const webRuntime = ctx.get('webRuntime')
    return webRuntime !== void 0 && Array.isArray(webRuntime.trustedHosts) && webRuntime.trustedHosts.includes(host)
  }

  const readJson = async (req) => {
    let body = ''
    for await (const chunk of req) body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    try {
      const parsed = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const handleMethod = async (method, payload) => {
    if (method === 'state' || method === 'diagnostics') return { ok: true, value: publicState() }

    if (method === 'member/upsert') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId.length === 0) return { status: 400, body: { ok: false, error: 'member/upsert 需要 sessionId' } }
      const known = store.state.members[sessionId] !== undefined
      if (!known && !(await sessionExists(ctx, sessionId))) {
        return { status: 404, body: { ok: false, error: `会话不存在：${sessionId}` } }
      }
      const result = store.upsert({
        sessionId,
        alias: payload.alias,
        color: payload.color,
        role: payload.role,
        caps: payload.caps,
        locked: payload.locked,
        pinned: payload.pinned,
        // ⚠️ `order` 原先**没有被转发**（2026-10-08 发现）：store.memberUpsert 支持它、面板排序
        //    （store.sortedMembers：pinned → order → sessionId）依赖它，但这条路由把它丢了 ⇒
        //    外部调用**无法**调整成员在面板里的位置。交接补位（让接任者落回原槽位）正需要它。
        order: payload.order,
        note: payload.note,
      })
      log(`${result.created ? 'promoted' : 'updated'} member ${sessionId}`)
      return { ok: true, value: { member: result.member, created: result.created, state: publicState() } }
    }

    if (method === 'member/remove') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      const result = store.remove(sessionId)
      log(`removed member ${sessionId} (removed=${String(result.removed)})`)
      return { ok: true, value: { removed: result.removed, state: publicState() } }
    }

    if (method === 'group/update') {
      const groupId = typeof payload.groupId === 'string' && payload.groupId.length > 0 ? payload.groupId : store.state.activeGroupId
      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 64) : ''
      const group = store.state.groups[groupId]
      if (group === undefined) return { status: 404, body: { ok: false, error: `群不存在：${groupId}` } }
      if (name.length === 0) return { status: 400, body: { ok: false, error: '群名不能为空' } }
      store.mutate((state) => ({
        state: { ...state, groups: { ...state.groups, [groupId]: { ...state.groups[groupId], name } } },
      }))
      return { ok: true, value: { state: publicState() } }
    }

    return { status: 404, body: { ok: false, error: `unknown method ${method}` } }
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!fence(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
          try {
            const payload = await readJson(req)
            const outcome = await handleMethod(method, payload)
            if (outcome.status !== undefined) sendJson(res, outcome.status, outcome.body)
            else sendJson(res, 200, outcome)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-studio: fenced api routes',
  )

  log(
    `host half loaded — data=${store.file} members=${store.members().length} ` +
      `archiveLock=${lock.installed ? 'installed' : `unavailable (${String(lock.reason)})`}`,
  )
}
