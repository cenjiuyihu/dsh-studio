// dsh-studio — 宿主半边：**消息优先级**（用户定的需求）。
//
// 目标顺序（高 → 低）：
//   ① 用户自己打的消息（没有群聊前缀的普通 user 消息）
//   ② 群聊里**人发起**的消息（发送者不是成员 —— 例如面板转达时写作 `来自 我`）
//   ③ 群聊里**成员发起**的消息
//
// 为什么必须放在宿主侧（这一条我查过源码，不是猜的）：
//   · `session.prompt` 只有 `queue` / `steer` 两种 mode（zod union，无 interrupt）；
//   · GUI 输入框和我们的 CLI **都走 `queue`** → `agent.followup()` → `Inbox` 的 `next-turn` 数组；
//   · `Inbox.claim()` 只取 `next-turn[0]`，`Agent.send()` 恒定**尾部追加** → 严格 FIFO，没有任何优先级概念。
//   所以"人优先"这件事在 RPC/客户端层**做不到**，只能在宿主插件里对 `Inbox` 原件动手。
//
// 安全前提（很重要，别改成 async）：
//   Node 是单线程，`claim()` 与本模块的重排都是**同步**函数。只要整段处理**不含任何 await**，
//   读 `inbox.nextTurn` → 计算 → 写回 之间就不可能有回合被 claim 走，也就不存在"把已消费的消息搬回来"
//   这类竞态。**一旦在这段里加 await，这个前提就没了。**
//
// 只做**重排**，不做抢占：正在跑的回合绝不打断（那需要 cancel/steer，是另一种语义），
// 也绝不删除或重发任何消息（重排只搬同一个对象，身份不变）。
//
// 关闭方式：环境变量 `DSH_STUDIO_PRIORITY=0`，或把本行从 composition 里去掉。

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_GROUP_ID, StudioStore } from './store.js'
import { resolveStoreFile } from './protocol.js'

export const name = 'dsh-studio/priority'

/** 群聊前缀（只要前缀，正文不关心；与 protocol.js / client.js 的口径一致）。 */
export const GROUP_PREFIX_RE = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)/

/** 优先级档位：数字越小越先被 claim。 */
export const PRIORITY = {
  user: 0,
  humanGroup: 1,
  memberGroup: 2,
  unknown: 2,
}

/** 一条消息的纯文本（`content` 里所有 text 块拼起来）。 */
export function messageText(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 判档：**先看有没有群聊前缀**，再看发送者是不是成员。
 * 这是整套优先级的唯一判据 —— 不猜身份、不看内容语义（内容不可靠，格式可靠，因为格式由 CLI/面板统一构造）。
 */
export function classify(message, memberLabels) {
  const text = messageText(message)
  if (text.length === 0) return 'unknown'
  const parsed = GROUP_PREFIX_RE.exec(text)
  if (parsed === null) return 'user'
  const sender = parsed[3].trim()
  return memberLabels.has(sender) ? 'memberGroup' : 'humanGroup'
}

export function rankOf(message, memberLabels) {
  return PRIORITY[classify(message, memberLabels)] ?? PRIORITY.unknown
}

/**
 * 按优先级做**稳定**排序（同档保持原有先来后到，不能打乱 FIFO 内部顺序）。
 * 返回 `{ items, changed }`：`changed === false` 时调用方不该动 Inbox（避免无意义的持久 splice 事件）。
 */
export function reorderByPriority(messages, memberLabels) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length < 2) return { items: [...list], changed: false }
  const ranked = list.map((message, index) => ({ message, index, rank: rankOf(message, memberLabels) }))
  const sorted = [...ranked].sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
  const changed = sorted.some((entry, index) => entry.index !== index)
  return { items: sorted.map((entry) => entry.message), changed }
}

/** 成员标签集合（带 mtime 缓存：入队是热路径，但没人会每秒改成员表）。 */
function createMemberCache(storeFile) {
  let cached = { labels: new Set(), mtimeMs: -1, error: undefined }
  return () => {
    try {
      const stat = fs.statSync(storeFile)
      if (stat.mtimeMs === cached.mtimeMs) return cached
      const store = new StudioStore(storeFile)
      store.load()
      const labels = new Set(store.members().map((member) => (member.alias.length > 0 ? member.alias : member.sessionId.slice(8, 16))))
      cached = { labels, mtimeMs: stat.mtimeMs, error: undefined }
      return cached
    } catch (error) {
      // 读不到成员表时**不排序**（宁可不优化，也不能把"人"当"成员"错判）。
      cached = { labels: new Set(), mtimeMs: cached.mtimeMs, error: error instanceof Error ? error.message : String(error) }
      return cached
    }
  }
}

/** 诊断状态：写一个小 JSON，重启后不看日志也能确认它到底有没有在工作。 */
function writeStatus(storeFile, status) {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(storeFile), 'priority.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  } catch {
    /* 诊断写不进去不影响重排 */
  }
}

export function apply(ctx) {
  const storeFile = resolveStoreFile()
  const memberCache = createMemberCache(storeFile)
  const status = {
    enabled: process.env.DSH_STUDIO_PRIORITY !== '0',
    // ★ 诊断分路（2026-09-20 实测教训）：插件报"已挂载"，但 `insertsSeen` 一直是 0 ——
    //   说明**处理器从未被调用**（而不是"没有消息进来"）。所以现在把两件事分开计数：
    //   `eventsReceived > 0` = 事件通道是通的；`byChannel` 指出是哪一种注册方式收到的。
    //   这也正好回答"`{global:true}` 到底对不对"——两个都注册，让数据说话。
    eventsReceived: 0,
    byChannel: { plain: 0, global: 0 },
    insertsSeen: 0,
    payloadShapeMiss: 0,
    skippedNoMembers: 0,
    nextTurnSplices: 0,
    reorders: 0,
    skippedNoChange: 0,
    errors: 0,
    lastReorder: undefined,
    lastError: undefined,
    startedAt: new Date().toISOString(),
    storeFile,
  }

  // ★ 诊断必须**每个事件都更新**（2026-09-22 自检踩到的坑）：`writeStatus` 原来只在
  //   "重排 / 异常 / 挂载 / 卸载"四处调用，而"事件到了但顺序本来就对"这条路径
  //   （`changed !== true` → `skippedNoChange` → return）**不落盘**。
  //   后果：磁盘上的 `eventsReceived: 0` 有两种完全不同的含义 ——
  //   ① 事件通道没通（插件坏了）；② 通道通了、只是这批消息不需要重排（插件正常）。
  //   光看文件分不出来，我本次就因此差点误判成"订阅失效"。
  //   ⇒ 改成"每次事件都更新内存 + 最多 2 秒落盘一次（带尾写）"，让 counters 真的可信。
  const FLUSH_MIN_MS = 2000
  let lastFlushMs = 0
  let flushTimer
  const flushNow = () => {
    lastFlushMs = Date.now()
    writeStatus(storeFile, status)
  }
  const flushThrottled = () => {
    const wait = FLUSH_MIN_MS - (Date.now() - lastFlushMs)
    if (wait <= 0) {
      flushNow()
      return
    }
    // 尾写：保证"最后一批计数"一定会落盘，而不是被节流窗口吃掉。
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushNow()
    }, wait)
  }

  const onInserted = (channel) => (payload) => {
    if (status.enabled !== true) return
    // **先计数、再做形状判断**：这样"事件没到"与"事件到了但 payload 形状不对"能一眼分开。
    status.eventsReceived += 1
    if (status.byChannel[channel] !== undefined) status.byChannel[channel] += 1
    try {
      // `payload.agent` 是宿主保证注入的：`agentEvents()` 的融合派发器做 `{ ...payload, agent }`
      // （见 `@deepseek-ai/dsh-agent/lib/types/dispatch.js` 第 42 行），
      // 而 `agent/inbox/inserted` 的原始 payload 只有 `{ message }`。所以读 agent/inbox 是对的。
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      const inbox = agent !== null && typeof agent === 'object' ? agent.inbox : undefined
      if (inbox === undefined || !Array.isArray(inbox.nextTurn)) {
        status.payloadShapeMiss += 1
        flushThrottled()
        return
      }
      status.insertsSeen += 1

      const pending = inbox.nextTurn
      if (pending.length < 2) {
        flushThrottled()
        return
      }

      const { labels } = memberCache()
      if (labels.size === 0) {
        // 静默返回是**不可观测**的：会让"没重排"看起来像"插件坏了"，所以单独计数。
        status.skippedNoMembers += 1
        flushThrottled()
        return
      }

      const { items, changed } = reorderByPriority(pending, labels)
      if (changed !== true) {
        status.skippedNoChange += 1
        flushThrottled()
        return
      }

      // ★ 全同步：读 → 算 → 写之间不能有 await，否则 claim 可能插进来。
      // `mutate(..., false)` 与 `claim()` 用的是同一个"不发布 discarded"路径 ——
      // 用公开的 `splice()` 会把搬走的消目标成 `outcome:"canceled"` 并推 discard 通知，
      // 看起来会像"消息被取消了"，而这里只是换了个位置。
      const mutate = typeof inbox.mutate === 'function' ? inbox.mutate.bind(inbox) : undefined
      if (mutate !== undefined) mutate('next-turn', 0, pending.length, items, false)
      else inbox.splice('next-turn', 0, pending.length, items)

      status.reorders += 1
      status.nextTurnSplices += 1
      status.lastReorder = {
        at: new Date().toISOString(),
        order: items.map((message) => classify(message, labels)),
        ids: items.map((message) => String(message.id ?? '')).slice(0, 6),
      }
      flushNow()
      console.log(
        `[dsh-studio/priority] 已重排 next-turn：${status.lastReorder.order.join(' > ')}（用户 > 人发起的群聊 > 成员发起的群聊）`,
      )
    } catch (error) {
      // 绝不能让本插件把宿主搞崩：任何异常都只记数并放过。
      status.errors += 1
      status.lastError = error instanceof Error ? `${error.message}` : String(error)
      flushNow()
      console.warn('[dsh-studio/priority] 重排失败（已忽略，不影响消息本身）', error)
    }
  }

  // ★ 注册方式（2026-09-20 由成员「主从守护」在**真实宿主**里用动态插件做 A/B 实测后确认）：
  //   `ctx.on('agent/inbox/inserted', h)` 与 `ctx.on(..., h, { global: true })` **行为完全一致**，
  //   两者都能收到**所有** agent（含别的会话）的事件。机制：host 平面的 `ctx.on` 注册在
  //   EventsService 的**根 ctx** 上（dsh-scope 里没有 scope 标签），而 scope 过滤规则是
  //   "监听器 ctx 无 scope 标签 ⇒ 一律放行"，所以 host 侧天生收得到全部；`{global:true}` 只是"无条件包含"。
  //   因此只保留一种注册（与 DsH 自带插件 `dsh-goal-round-driver` 写法一致），避免事件被计两次。
  //
  //   当时我误判成"注册写错了"，实际是**插件实例没真正挂载完**（HMR 让 apply 跑到一半就没了，
  //   见 `priority.json.startedAt` 有更新、但 supervisor 日志没有对应的"已挂载"行）。
  //   ⇒ 正确做法就是重启主星一次；代码本身没问题。
  try {
    ctx.on('agent/inbox/inserted', onInserted('plain'))
    status.subscribed = ['plain']
  } catch (error) {
    status.errors += 1
    status.lastError = `subscribe: ${error instanceof Error ? error.message : String(error)}`
  }

  writeStatus(storeFile, status)
  console.log(
    `[dsh-studio/priority] 已挂载（enabled=${status.enabled}，群=${DEFAULT_GROUP_ID}，订阅=${(status.subscribed ?? []).join('+')}）——` +
      '人的消息 > 人发起的群聊消息 > 成员发起的群聊消息；只重排、不抢占、不删除。',
  )

  ctx.effect(() => () => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    status.stoppedAt = new Date().toISOString()
    writeStatus(storeFile, status)
  })
}
