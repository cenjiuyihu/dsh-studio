// dsh-studio — 群聊协议的**唯一**定义处（纯函数，不依赖任何框架）。
//
// 三个消费者共享它，避免前缀格式各写一份：
//   1. `src/tools.js`  —— 宿主工具半边（studio_say / studio_members）
//   2. `bin/say.mjs`   —— 命令行接口（agent 无需宿主工具也能群聊）
//   3. `src/client.js` —— 面板（构造与解析，浏览器侧）
//
// 格式： `【群聊·<群名>｜<类型>｜来自 <发送者>】\n<正文>`
// 为什么用文本前缀：`user/message` 的 `source` 字段由宿主在 `session.prompt` 里构造
// （dsh-host-apiproxy/lib/index.js:2744-2748），客户端与工具都注入不了自定义来源；
// 而且前缀能让**对端模型直接看见**这条消息的群聊归属与类型。

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 群聊消息前缀的开头标记（客户端与工具都靠它识别"这条是群聊消息"）。
 * 完整格式：
 *   【群聊·<群名>｜<类型>｜来自 <发送者>｜#<短id>】\n<正文>
 * 短 id 是可选的第 4 段（旧消息没有也能解析），用于 `--reply-to <短id>` 精确引用某条消息。
 */
export const GROUP_MARK = '【群聊·'

/** 解析正则：群名 / 类型 / 发送者 都不允许含全角竖线或右书名号；短 id 可选。 */
export const GROUP_LINE_RE = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)(?:｜#([0-9a-zA-Z]{4,12}))?】\r?\n?([\s\S]*)$/

/** 新消息的短 id（6 位十六进制，便于人肉引用）。 */
export function newGroupMessageId() {
  return randomBytes(3).toString('hex')
}

/** 构造一条群聊消息正文。`id` 省略时不带短 id 段（向后兼容）。 */
export function groupText(group, kind, from, body, id) {
  const tag = typeof id === 'string' && id.length > 0 ? `｜#${id}` : ''
  return `${GROUP_MARK}${group}｜${kind}｜来自 ${from}${tag}】\n${body}`
}

/** 解析一条群聊消息；不是群聊消息则返回 undefined。 */
export function parseGroupText(text) {
  const match = GROUP_LINE_RE.exec(String(text ?? '').trim())
  if (match === null) return undefined
  return { group: match[1], kind: match[2], from: match[3], id: match[4], body: match[5] }
}

/** 会话 id 的短形式（给人看的信息里代替一长串 uuid）。 */
export function shortId(sessionId) {
  const text = String(sessionId ?? '')
  const bare = text.startsWith('session-') ? text.slice(8) : text
  return bare.slice(0, 8)
}

/**
 * `--inbox` 的判定规则（纯函数，**从 bin/say.mjs 里抽出来就是为了可单测**）。
 *
 * 为什么抽出来：成员「教练成员」复验时如实报告"⚪ 无法判定（比我最早的发出记录还早 N 秒）"
 * 这条分支在它的会话里**没有触发**，所以那一轮验收没有覆盖它；它问"要不要给我个场景专测"。
 * 让它靠构造历史来触发是不现实的（账本只会越来越完整，这条分支是**收窄中的边角**）。
 * 抽成纯函数后用单测覆盖全部 8 个分支，比任何真实场景都稳。
 *
 * 判据（顺序即优先级）：
 *   1. 非成员发送者 → 不判定（人类在面板里转达的消息不该算成"某个成员发的"）
 *   2. 是 ask 且已有回执（ack/decline/deliver）→ ✅ 已回执
 *   3. 是 ask 且回过话但没回执 → ⚠️ 欠回执（发起方拿不到"接没接"）
 *   4. 回过话 → ✅ 之后我回过消息
 *   5. 是 ask、在覆盖范围内、有证据 → ⚠️ 欠回执（什么都没回）
 *   6. 在覆盖范围内、有证据 → ⚠️ 之后我没回过
 *   7. 有证据但这条早于覆盖起点 → ⚪ 无法判定（还早 N 秒）
 *   8. 一条证据都没有 → ⚪ 无法判定
 */
export function inboxVerdict(input) {
  const { kind, isMember, replied, receiptKind, coverageStart, at, hasEvidence, gapSeconds, repliesToMine } = input
  if (isMember !== true) {
    return { verdict: '⚪ 非成员发送者（人类在面板里转达的），不计入回复判定', debt: false }
  }
  const isAsk = kind === 'ask'
  if (isAsk && typeof receiptKind === 'string' && receiptKind.length > 0) {
    return { verdict: `✅ 已回执（${receiptKind}）`, debt: false }
  }
  if (isAsk && replied === true) {
    return { verdict: '⚠️ 欠回执：回过话，但没给正式的接单/推掉回执', debt: true }
  }
  if (replied === true) return { verdict: '✅ 之后我回过消息', debt: false }
  // 它是**回复我某一条**的（正文引用行指向我发出的消息）→ 这一来一回已经闭环，不是欠账。
  // 成员「教练成员」举了 5/5 的反例：deliver/ack 本来就不需要回，标 ⚠️ 会让这个标记失去信号价值。
  if (typeof repliesToMine === 'string' && repliesToMine.length > 0) {
    return { verdict: `✅ 已闭环（它回的是我发的 #${repliesToMine}）`, debt: false }
  }
  const covered = Number.isFinite(coverageStart) && at >= coverageStart
  if (isAsk && covered && hasEvidence === true) {
    return { verdict: '⚠️ 欠回执：这条 ask 之后我什么都没回', debt: true }
  }
  // ★ `⚠️` **只允许出现在 ask 上**：只有 ask 有回执义务。非 ask 的"我没回过"按礼节就是正确行为
  //   （deliver/ack/progress/say/share 都不需要回），用中性标记，不制造虚高的欠账。
  if (covered && hasEvidence === true) {
    return { verdict: '○ 未回过（非 ask，按礼节无需回执）', debt: false }
  }
  if (hasEvidence === true) {
    const gap = typeof gapSeconds === 'number' && Number.isFinite(gapSeconds) ? gapSeconds : Math.max(1, Math.round((coverageStart - at) / 1000))
    return { verdict: `⚪ 无法判定（这条比我最早的发出记录还早 ${gap} 秒，没被覆盖，别据此重发）`, debt: false }
  }
  return { verdict: '⚪ 无法判定（一条发出记录都没有，别据此重发）', debt: false }
}

/** `--inbox` 结尾的判据行（也抽出来，保证"判据"与"判定"用的是同一组数）。 */
export function inboxEvidenceLine(sentCount, scannedMembers) {
  return (
    `\n判据：本地发送账本（${sentCount} 条发出记录）` +
    (scannedMembers > 0 ? ` + 扫了 ${scannedMembers} 位成员的会话` : '') +
    '。回消息用 --to "<发起者名>" --kind deliver --text-file <文件>；'
  )
}

/**
 * 「执行中」的观察式进度：把一次 `tool/call` 事件归纳成人类可读的一步。
 *
 * 事件形状（实测自真实会话日志，不是猜的）：
 *   `{turn, step, callId, name: "pwsh"|"edit"|"read"|..., arguments: "<JSON 字符串>"}`
 * 注意 `arguments` 是**字符串**，需要再 JSON.parse 一次（解析失败就退化成"工具不可识别"）。
 *
 * 这是**观测到的事实**，不是推测 —— 委托方因此不用再自己去轮询文件系统。
 * 工具参数不透明时如实回 `other`，绝不编造"正在改 X 文件"。
 */
export function summarizeToolCall(name, rawArguments) {
  const tool = String(name ?? '').trim()
  let args = {}
  if (typeof rawArguments === 'string' && rawArguments.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawArguments)
      if (parsed !== null && typeof parsed === 'object') args = parsed
    } catch {
      args = {}
    }
  } else if (rawArguments !== null && typeof rawArguments === 'object') {
    args = rawArguments
  }
  const firstString = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
    return undefined
  }
  const shorten = (value, max = 48) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`)
  const filePath = firstString(args.file_path, args.path, args.notebook_path, args.filePath)
  const shortPath = filePath !== undefined ? shorten(filePath.split(/[\\/]/).slice(-2).join('/')) : undefined

  if (/^(edit|write|multi_edit|apply_patch|create_file|str_replace)/i.test(tool)) {
    return { kind: 'edit', label: shortPath !== undefined ? `改 ${shortPath}` : `改文件（${tool}）` }
  }
  if (/^(read|grep|glob|list_dir|ls|view)/i.test(tool)) {
    return { kind: 'read', label: shortPath !== undefined ? `读 ${shortPath}` : `读文件（${tool}）` }
  }
  if (/^(pwsh|bash|shell|sh|cmd|exec|run_command|terminal)/i.test(tool)) {
    const command = firstString(args.command, args.cmd, args.script)
    return {
      kind: 'command',
      label: command !== undefined ? `跑命令：${shorten(command.split('\n')[0], 40)}` : '跑命令',
    }
  }
  return { kind: 'other', label: tool.length > 0 ? `调用 ${tool}` : '调用了一个工具' }
}

/** 成员的显示名。 */
export function labelOf(member) {
  return member.alias.length > 0 ? member.alias : shortId(member.sessionId)
}

/**
 * 一个成员是否已「退役」（交接后保留的旧会话 / 已解锁、随时可归档的记录）。
 *
 * 判据两条，任一成立即为退役：
 *   ① 别名带退役前缀，形如 `旧[2026-10-08]维护者` / `旧·维护者`（见 RETIRED_ALIAS）；
 *   ② `locked === false` —— 本部署里「锁定」的语义是**禁止归档**（见 store.isLocked），
 *      所以解锁记录＝"随时可以被归档的旧记录"，正是 2026-10-08 交接时特意留下的状态。
 *
 * 为什么要单独判退役：交接后新旧会话**同名**（`维护者` / `旧[…]维护者`）。实测
 * `--to 维护` 会掉到子串匹配、并被**排在成员表前面**的旧记录接住 ⇒ 消息进已退役会话。
 */
const RETIRED_ALIAS = /^\s*旧[\s·・•\-–—_\[（(【]/

export function isRetired(member) {
  if (member === undefined || member === null) return false
  if (member.locked === false) return true
  return RETIRED_ALIAS.test(String(member.alias ?? ''))
}

/**
 * 解析层级（数字越小越优先）：
 *   0 精确别名 · 1 完整会话 id · 2 短 id · 3 别名前缀 · 4 别名子串。
 * 退役记录在 **3/4 两级**上加 10 ⇒ 任何**未退役**的模糊命中都胜过退役的模糊命中；
 * 而精确命中（0/1/2）不受影响 —— 写全名或短 id 永远能精确点到那条记录。
 */
function matchRank(member, wanted, lower) {
  const alias = String(member.alias ?? '')
  const aliasLower = alias.toLowerCase()
  if (alias.length > 0 && aliasLower === lower) return 0
  if (String(member.sessionId) === wanted) return 1
  if (shortId(member.sessionId) === lower) return 2
  const penalty = isRetired(member) ? 10 : 0
  if (aliasLower.startsWith(lower)) return 3 + penalty
  if (aliasLower.includes(lower)) return 4 + penalty
  return -1
}

/** 兼容交接**之前**的旧写法：`维护者(旧)` / `维护者（旧）`。 */
const LEGACY_RETIRED_SUFFIX = /[\(（]\s*旧\s*[\)）]\s*$/

/** 按别名（不区分大小写）/ 完整 id / 短 id / 别名前缀 / 别名子串，找出**全部并列最优**候选。 */
export function findMemberCandidates(members, query) {
  let wanted = String(query ?? '').trim()
  if (wanted.length === 0) return []
  // 带 `(旧)` 后缀的查询 = 明确在问**那条退役记录** ⇒ 只在退役记录里找，并先去掉后缀再比。
  // 否则 `维护者(旧)` 会被"精确别名"这一级判给**新**记录（新记录的别名正是去掉后缀后的 `维护者`）。
  const legacy = LEGACY_RETIRED_SUFFIX.test(wanted)
  const pool = legacy ? members.filter(isRetired) : members
  if (legacy) wanted = wanted.replace(LEGACY_RETIRED_SUFFIX, '').trim()
  if (wanted.length === 0) return []
  const lower = wanted.toLowerCase()
  const hits = []
  let best = Number.POSITIVE_INFINITY
  for (const member of pool) {
    const rank = matchRank(member, wanted, lower)
    if (rank < 0) continue
    if (rank < best) {
      best = rank
      hits.length = 0
    }
    if (rank === best) hits.push(member)
  }
  return hits
}

/**
 * 找成员：**并列最优有多条时返回 undefined（不猜）**。调用方应把候选打印出来。
 *
 * 为什么不取"第一个命中"：猜错的代价是消息投进**错的会话**（且看起来像正常投递），
 * 而"不猜"的代价只是发送者多打几个字。⇒ 本项目约定：改名 + 强化解析。
 */
export function findMember(members, query) {
  const hits = findMemberCandidates(members, query)
  return hits.length === 1 ? hits[0] : undefined
}

/** 工作室数据文件：`$DSH_HOME/studio/studio.json`（与宿主半边同一个文件）。 */
export function resolveStoreFile() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(home, 'studio', 'studio.json')
}

// ───────────────────────── "我发过什么" 的本地账本 ─────────────────────────
//
// 为什么需要它：我用 CLI/工具发出的消息进入的是**对方**的会话，**我自己**的会话里没有记录。
// 所以只靠"读自己的会话历史"无法判断"这条我回过没有" —— 会永远误报"没回过"。
// 这里把每次发送追加到一个 jsonl 账本，供 `--inbox` 之类的查询使用。
// （成员「教练成员」独立复现并报告了这个判定缺陷。）

/** 发送账本路径。 */
export function resolveSentLogFile() {
  return path.join(path.dirname(resolveStoreFile()), 'sent.jsonl')
}

const SENT_LOG_MAX_BYTES = 200 * 1024
const SENT_LOG_TRIM_LINES = 300

/** 追加一条发送记录（失败不影响发送本身）。 */
export function appendSentLog(entry) {
  const file = resolveSentLogFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    if (fs.statSync(file).size > SENT_LOG_MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
      fs.writeFileSync(file, `${lines.slice(-SENT_LOG_TRIM_LINES).join('\n')}\n`, 'utf8')
    }
  } catch {
    /* 账本只是便利设施，写不进去也不能影响发送 */
  }
}

/** 读取发送账本（新→旧无关，调用方自己筛）。 */
export function readSentLog() {
  try {
    return fs
      .readFileSync(resolveSentLogFile(), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((entry) => entry !== undefined)
  } catch {
    return []
  }
}

/** 从一条会话事件里取出纯文本（user/message 与 assistant/message）。 */
export function eventText(event) {  if (event === null || typeof event !== 'object') return ''
  let message
  if (event.type === 'user/message') message = event.data
  else if (event.type === 'assistant/message') {
    message = event.data !== null && typeof event.data === 'object' ? event.data.message : undefined
  } else return ''
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}
