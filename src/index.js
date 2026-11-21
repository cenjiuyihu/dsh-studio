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

import fs from 'node:fs'
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

/** 双星系统控制目录：`$DSH_HOME/binary-star/control`。
 *  与会话继承相关的握手全走这里 —— 监督者是独立进程，control 目录是两边既有的
 *  约定方式（restart-request.json / inherit-request.json / shutdown 都已经在用）。 */
function resolveControlDir() {
  return path.join(path.dirname(resolveStoreFile()), '..', 'binary-star', 'control')
}

/** 读一个 JSON 文件；不存在或坏掉都返回 fallback（这些是"尽力而为"的展示数据）。 */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
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

  // ───────────────────────── P4：交接插队 + 自动转投（2026-10-21）─────────────────────────
  //
  // 职责划分（为什么这样分）：
  //   · 宿主 RPC `session.updateQueue` 只支持 edit/remove/steer（按 itemId），**既不能列队列也不能重排**；
  //   · 读/改队列只能用 `ctx.get('agents').get(id).inbox`，那只有**宿主插件**拿得到；
  //   · 但往新会话**投递**需要 `session.prompt`，那是监督者本来就会的。
  //   ⇒ 工作室负责"读 + 删"，监督者负责"投"。任何一侧失败都不会丢消息。
  //
  // 只放内存：重启即清空（与用户"重启后重新提醒即可"的口径一致，避免状态腐化）。
  const handoverSessions = new Set()
  const BRIEF_MARKER = '【交接简报指令】'

  /** 从一条 inbox 消息里取纯文本（只认 text 块，其余类型忽略）。 */
  function textOfMessage(message) {
    const content = message !== null && typeof message === 'object' ? message.content : undefined
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }

  /** 取某会话的 inbox（拿不到就返回 undefined，调用方一律要兜底）。 */
  function inboxOf(sessionId) {
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    let agent
    try {
      agent = agents.get(sessionId)
    } catch {
      return undefined
    }
    const inbox = agent !== null && typeof agent === 'object' ? agent.inbox : undefined
    return inbox !== undefined && inbox !== null && Array.isArray(inbox.nextTurn) ? inbox : undefined
  }

  /**
   * 写回 next-turn 顺序。
   * ⚠️ `mutate(..., false)` 与 `Inbox.claim()` 共用"不发布 discarded"的路径 —— 这是 priority.js
   *    已经验证过的写法；老宿主没有 mutate 时退回 splice。
   */
  function writeTurnOrder(inbox, items) {
    const length = inbox.nextTurn.length
    if (typeof inbox.mutate === 'function') inbox.mutate('next-turn', 0, length, items, false)
    else if (typeof inbox.splice === 'function') inbox.splice('next-turn', 0, length, items)
  }

  /**
   * 把交接简报指令**挪到队首**。
   *
   * 「优先于用户新回合」的真实含义：**赢下一条的顺序**，而不是抢占正在跑的回合。
   * 抢占会把半截工作写进简报；而插队只影响「这一轮结束后先跑谁」。
   */
  function hoistBrief(sessionId) {
    const inbox = inboxOf(sessionId)
    if (inbox === undefined) return false
    const index = inbox.nextTurn.findIndex((message) => textOfMessage(message).includes(BRIEF_MARKER))
    if (index <= 0) return false
    const items = [...inbox.nextTurn]
    const [brief] = items.splice(index, 1)
    items.unshift(brief)
    writeTurnOrder(inbox, items)
    log(`handover hoist：简报指令移到 ${shortSessionId(sessionId)} 队首（原第 ${index + 1} 条）`)
    return true
  }

  ctx.effect(
    () =>
      ctx.on('agent/inbox/inserted', (payload) => {
        try {
          // `payload.agent` 由宿主融合派发器注入（`{ ...payload, agent }`），
          // 原始 payload 只有 `{ message }` —— 这是 priority.js 已经核实过的形状。
          const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
          const sessionId =
            agent !== null && typeof agent === 'object'
              ? (agent.session !== undefined && agent.session !== null ? agent.session.id : agent.id)
              : undefined
          if (typeof sessionId !== 'string' || !handoverSessions.has(sessionId)) return
          const message = payload !== null && typeof payload === 'object' ? payload.message : undefined
          if (!textOfMessage(message).includes(BRIEF_MARKER)) return
          hoistBrief(sessionId)
        } catch (error) {
          log(`handover hoist failed (ignored): ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    'dsh-studio: handover brief hoist',
  )

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

    // ── 会话继承：阈值提醒与手动触发（2026-10-21，见 docs/plan-inherit-alerts.md）──
    // 这三个路由只做**文件搬运**：
    //   面板 → control/inherit-request.json / inherit-alerts.json（监督者读）
    //   监督者 → control/inherit-status.json（面板读）
    // 为什么不开新协议：监督者是独立进程，control 目录是两边既有的握手方式。
    if (method === 'inherit/status') {
      const status = readJsonSafe(path.join(resolveControlDir(), 'inherit-status.json'), null)
      return {
        ok: true,
        value:
          status === null
            ? { status: null, reason: '监督者尚未写出 inherit-status.json（观察循环还没跑到第一批，约需 60 秒）' }
            : { status },
      }
    }

    if (method === 'inherit/request') {
      // 手动触发交接。**不受 inherit.enabled 门控** —— 那是"自动触发"的开关，
      // 手动点击是明确意图，随时可跑（与 supervise.js 里 handleInheritRequest 的口径一致）。
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId.length === 0) return { status: 400, body: { ok: false, error: 'inherit/request 需要 sessionId' } }
      const dir = resolveControlDir()
      const file = path.join(dir, 'inherit-request.json')
      const doneMarker = `${file}.done`
      // 已有一个在队列里就拒绝——监督者同一时刻只处理一个交接（见 §8.1 三动作契约）
      if (fs.existsSync(file)) {
        return { status: 409, body: { ok: false, error: '已有一个交接请求在队列里（control/inherit-request.json 已存在）' } }
      }
      fs.mkdirSync(dir, { recursive: true })
      // cwd 故意不传：监督者会优先取旧会话自己的 cwd（oldMeta.cwd），比面板猜的准
      const body = {
        oldSessionId: sessionId,
        reason: typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : '面板手动触发',
        groupChat: payload.groupChat !== false,
      }
      fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
      log(`inherit/request written for ${shortSessionId(sessionId)} (groupChat=${String(body.groupChat)})`)
      return { ok: true, value: { written: true, doneMarkerExists: fs.existsSync(doneMarker) } }
    }

    if (method === 'inherit/alerts') {
      // 取消/恢复报警：muted=true ⇒ 三档全静音，继承完全手动（见计划书 §6）
      const muted = payload.muted !== false
      const dir = resolveControlDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'inherit-alerts.json'),
        JSON.stringify({ muted, at: new Date().toISOString(), by: 'panel' }, null, 2),
        'utf8',
      )
      log(`inherit/alerts muted=${String(muted)}`)
      return { ok: true, value: { muted } }
    }

    // ── P4：交接插队 + 自动转投（监督者调用；见 supervisor.js 的 drainOldInbox）──
    if (method === 'handover/queue') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId.length === 0) return { status: 400, body: { ok: false, error: 'handover/queue 需要 sessionId' } }
      handoverSessions.add(sessionId)
      log(`handover queue: ${shortSessionId(sessionId)} 进入交接（简报将插队到 next-turn 队首）`)
      return { ok: true, value: { queued: true } }
    }

    if (method === 'handover/pending') {
      // **只读**：把旧会话 next-turn 里待处理的消息文本交给监督者去投递。
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId.length === 0) return { status: 400, body: { ok: false, error: 'handover/pending 需要 sessionId' } }
      const inbox = inboxOf(sessionId)
      if (inbox === undefined) return { ok: true, value: { pending: [], reason: 'inbox 不可用（会话未挂载或已冷存）' } }
      const pending = inbox.nextTurn
        .map((message) => ({ id: message !== null && typeof message === 'object' ? message.id : undefined, text: textOfMessage(message) }))
        // 简报指令本身不转投（它是要旧会话执行的，搬走会把它自己的任务带走）
        .filter((item) => typeof item.id === 'string' && item.text.length > 0 && !item.text.includes(BRIEF_MARKER))
      return { ok: true, value: { pending } }
    }

    if (method === 'handover/purge') {
      // **先投后删**里的"删"：只删监督者确认投递成功的那几条。
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
      if (sessionId.length === 0) return { status: 400, body: { ok: false, error: 'handover/purge 需要 sessionId' } }
      if (ids.length === 0) return { ok: true, value: { removed: 0 } }
      const inbox = inboxOf(sessionId)
      if (inbox === undefined) return { ok: true, value: { removed: 0, reason: 'inbox 不可用' } }
      const keep = inbox.nextTurn.filter((message) => !ids.includes(message !== null && typeof message === 'object' ? message.id : undefined))
      const removed = inbox.nextTurn.length - keep.length
      if (removed > 0) {
        writeTurnOrder(inbox, keep)
        log(`handover purge: 从 ${shortSessionId(sessionId)} 移除已转投的 ${removed} 条`)
      }
      return { ok: true, value: { removed } }
    }

    if (method === 'handover/done') {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      handoverSessions.delete(sessionId)
      return { ok: true, value: { queued: false } }
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
