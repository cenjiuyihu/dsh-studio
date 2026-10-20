#!/usr/bin/env node
// dsh-studio — 命令行群聊接口（给 **agent** 用，无需宿主工具即可工作）。
//
// 为什么需要它：原生工具 `studio_say` 走的是宿主插件条目，而宿主条目一旦加载就不会重新 import
// （cordis-plugin-hmr 只监视 profile 目录，本包源码在 profile 目录之外），**必须重启主星才生效**。
// 这个 CLI 直接调用产品自己的 RPC（与输入框发消息同一条 `POST /api/session.prompt`），
// 所以**立刻可用**，而且语义完全一致：`mode:"queue"` → 宿主侧 `agent.followup()` → 排队不抢占。
//
// 用法（任何会话里执行都可以）：
//   node <此文件> --list                                   列出成员（含忙/闲）
//   node <此文件> --inbox                                  看我收到了哪些群聊消息、回没回
//   node <此文件> --to "教练成员" --text "帮我看一下这个模板"
//   node <此文件> --to "站点成员" --kind ask --text-file C:\tmp\msg.md     ← 正文含引号/代码/JSON 时用这个
//   node <此文件> --to "站点成员" --text -                      ← 从标准输入读正文
//
// `--from` 省略时自动取 `$DSH_SESSION_ID`（当前会话），所以发送者身份**自动且正确**。
//
// ⚠️ Windows 命令行引号坑：`--text "...含 ASCII 双引号..."` 会被 cmd/pwsh 撕开参数。
//    正文里要放代码/JSON/引用原文时，**一律用 `--text-file` 或 `--text -`**。

import fs from 'node:fs'
import path from 'node:path'
import { StudioStore } from '../src/store.js'
import { GROUP_LINE_RE, appendSentLog, findMember, findMemberCandidates, isRetired, groupText, labelOf, newGroupMessageId, readSentLog, resolveStoreFile, shortId, inboxVerdict } from '../src/protocol.js'

const DEFAULT_WEB_URL = 'http://127.0.0.1:3080'
const KINDS = ['say', 'ask', 'deliver', 'share', 'ack', 'decline', 'progress']
/**
 * CLI 版本号。**每次改动都 +1**，并提供 `--version` ——
 * 这样"你测的是哪一版"可以直接问出来，不用靠猜（这次就因为版本不同多绕了一轮）。
 */
const CLI_VERSION = '1.6.0'
const CLI_FEATURES = [
  '--text-file/--text -',
  '--ack/--decline 回执（接单/推掉）',
  '--progress 执行中进度（接单之后、交付之前）',
  '--inbox（账本+成员扫描+欠账提醒+我发出 ask 的进展）',
  '--list 忙闲',
  '--to A,B/@all',
  '--on-behalf-of',
  '短id/--reply-to',
  '--pause/--unpause/--pause-status 暂停闸门',
]

function parseArgs(argv) {
  const out = { kind: 'say' }
  const flags = new Set([
    '--list',
    '-l',
    '--help',
    '-h',
    '--dry-run',
    '--inbox',
    '--version',
    '-v',
    '--set-card',
    '--unpause',
    '--pause-status',
    // ★ `--force` 必须在这里。它一度漏在外面 ⇒ 被 parseArgs 当成"需要值的参数"，
    //   于是每次用都是 `参数 --force 缺少值` —— 也就是说：限流闸门与暂停闸门的
    //   **急诊出口从来没通过**。发现的经过值得记住：我只验过"该拦时拦住了"，
    //   没验过"该放行时放得行"；一个没有出口的闸门会把人赶去**绕开 CLI**
    //   （面板/原生工具），那条路不受任何闸门约束，比不设闸门更糟。
    '--force',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (flags.has(token)) {
      if (token === '--list' || token === '-l') out.list = true
      else if (token === '--inbox') out.inbox = true
      else if (token === '--dry-run') out.dryRun = true
      else if (token === '--version' || token === '-v') out.version = true
      else if (token === '--set-card') out.setCard = true
      else if (token === '--unpause') out.unpause = true
      else if (token === '--pause-status') out.pauseStatus = true
      else if (token === '--force') out.force = true
      else out.help = true
      continue
    }
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_all, char) => char.toUpperCase())
      const value = argv[index + 1]
      if (value === void 0 || (value.startsWith('--') && value !== '-')) throw new Error(`参数 --${key} 缺少值`)
      out[key] = value
      index += 1
      continue
    }
    throw new Error(`无法识别的参数：${token}`)
  }
  return out
}

/**
 * 正文参数是否给了。
 * 注意：**不能**用 resolveBody() 来判断 —— 它会真的去读 stdin，
 * 而 stdin 只能读一次（先被这里读干，后面构造正文就永远是空的）。
 */
function hasBodyArg(args) {
  return args.textFile !== void 0 || args.text !== void 0
}

/**
 * `--text` 的**门禁**：正文里含半角双引号时直接拒绝，并指路 `--text-file` / `--text -`。
 *
 * 为什么值得拦：成员「站点成员」**第四次**踩这个坑时自己反思——
 *   "我明明给自己做了『含双引号就拒绝发送』的门禁，却只在部分命令上用了它"。
 * 与其靠每个 agent 自己记得，不如让 CLI 统一拦：Windows 下 `--text "...\"...\"..."` 基本注定被
 * cmd/pwsh 撕开（我们实测过 `无法识别的参数：：4` 这类报错），拦住比让它带着残缺参数发出去安全得多。
 * 注意 `--text -`（stdin）与 `--text @路径` 不受影响 —— 那两条通路本来就不过 shell 的参数解析。
 */
function guardTextQuoting(args) {
  const value = args.text
  if (typeof value !== 'string') return
  if (value === '-' || value.startsWith('@')) return
  if (!value.includes('"')) return
  throw new Error(
    '--text 的正文里含半角双引号：Windows 下它几乎一定被 shell 撕开（实测报错形如「无法识别的参数：：4」）。\n' +
      '      请改用 --text-file <文件.md> 或 --text -（从标准输入读）—— 这两条通路不过 shell 的参数解析。\n' +
      '      这不是 CLI 的限制，是为了不让残缺的正文被发出去。',
  )
}

/** 正文来源：--text（支持 `-` 读 stdin、`@路径` 读文件）或 --text-file。 */
function resolveBody(args) {  const raw = args.textFile !== void 0 ? `@${args.textFile}` : args.text
  if (raw === void 0) return undefined
  if (raw === '-') return fs.readFileSync(0, 'utf8').trim() // stdin
  if (raw.startsWith('@')) {
    const file = raw.slice(1)
    if (!fs.existsSync(file)) throw new Error(`正文文件不存在：${file}`)
    return fs.readFileSync(file, 'utf8').trim()
  }
  return raw
}

/** 调产品自己的 RPC（与面板/输入框同一条通路）。 */
async function callRpc(baseUrl, method, payload) {
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `studio-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload,
    }),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
}

function usage(state, members) {
  const names = members.map((member) => `${labelOf(member)}${member.role.length > 0 ? `（${member.role}）` : ''}`)
  return [
    '用法：',
    '  node <此文件> --list',
    '  node <此文件> --inbox',
    '  node <此文件> --to <成员名或会话id> --text "<消息>" [--kind say|ask|deliver|share]',
    '  node <此文件> --to "A,B" 或 --to @all --text-file <正文.md> [--on-behalf-of <成员>]',
    '  node <此文件> --to <成员名> --text-file <正文文件.md>     ← 正文含引号/代码/JSON 时**必须**用这个',
    '  node <此文件> --to <成员名> --text -                      ← 从标准输入读正文',
    '  node <此文件> --to <成员名> --reply-to <短id> --text-file <正文.md>   ← 精确引用某一条',
    '  node <此文件> --ack <短id> --text-file <正文.md>          ← 回执：我接了（收件人自动 = 那条 ask 的发起者）',
    '  node <此文件> --decline <短id> --text-file <正文.md>      ← 回执：我推掉（同上）',
    '  node <此文件> --progress <短id> --text-file <正文.md>     ← 执行中：接单之后、交付之前报一句进度',
    '  node <此文件> --version                                    ← 看当前是哪一版',
    '  node <此文件> --set-card --role "一行角色" --caps "标签1,标签2,标签3"   ← 填我自己的成员卡（名字/颜色不动）',
    '  node <此文件> --pause-status                              ← 看群聊现在是否被暂停（只读，不受暂停影响）',
    '  node <此文件> --pause 60 [--scope "成员A,成员B"] [--reason "为什么"]  ← 暂停发送（到点自动失效；缺省全体 60 分钟）',
    '  node <此文件> --unpause                                   ← 解除暂停',
    '',
    '三道闸门（都不需要重启主星，都可用 --force 越过；越过会打印出来）：',
    '  ① 暂停闸门 —— 这段时间一条都不发（`--pause`）；',
    '  ② 限流闸门 —— 同目标 60 秒内重复 / 60 秒内 ≥6 条 / 10 分钟内二次广播；',
    '  ③ 定向自检 —— 首行写「→ 某人」却发给了别人时告警（只告警，不阻断）。',
    '',
    `群：${state.activeGroupId}    成员（${members.length}）：${names.length > 0 ? names.join('、') : '（空）'}`,
  ].join('\n')
}

/**
 * 发送侧熔断（本地限流）—— 第二层闸门。
 *
 * 为什么需要（一次消息风暴事故之后）：当时单小时到达量远超服务能力、广播占了很大比例，
 * **74% 是信息性消息**（deliver/say/share），而**每一条都会让对方跑一个完整回合**
 * ⇒ 用户侧看到 16 / 32 / 28 条排队，正常对话被挤掉。
 *
 * 这里拦三类最典型的放大器：
 *   ① **对同一目标** 60 秒内重复发（多数是"回执 / 我同意 / 补充一句"式的寒暄）；
 *   ② 同一发送者 60 秒内总发送 ≥ 6 条（刷屏）；
 *   ③ 同一发送者 **10 分钟内第二次广播** —— 一次广播 = N 条投递，放大最强。
 *
 * **只做本地判断，不依赖宿主任何新接口** ⇒ 不需要重启主星；`--force` 可覆盖任何一条。
 * 它拦不住别人，但能让**走这条通路的人**都受同一套约束 —— 限流的意义在于"发之前先被问一次"。
 */
const SEND_RATE_WINDOW_MS = 60_000
const SEND_RATE_MAX_PER_MINUTE = 6
const BROADCAST_WINDOW_MS = 10 * 60_000
const SEND_RATE_KEEP = 500

function sendRateFile(storeFile) {
  return path.join(path.dirname(storeFile), 'send-rate.json')
}

function enforceSendRate({ storeFile, from, targets, kind, force }) {
  if (force === true) return
  const file = sendRateFile(storeFile)
  let log = []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (Array.isArray(parsed)) log = parsed
    // ★ 绝不静默：文件存在但形状不对（例如被别的工具写成了对象）时，必须说出来。
    //   否则限流会**悄悄失效**，而调用方以为它在工作 —— 这与今天那条
    //   "缺失值不能被渲染成正常的读数" 是同一族错误。实测踩过一次（用 PowerShell 写测试数据时）。
    else console.error(`⚠️ 发送速率台账形状不对（顶层不是数组）：${file} —— 本次按"无记录"处理，限流强度会下降。`)
  } catch (error) {
    if (fs.existsSync(file)) console.error(`⚠️ 发送速率台账读不出（${file}）：${error instanceof Error ? error.message : String(error)}`)
    log = []
  }
  const now = Date.now()
  log = log.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.at === 'number' && now - entry.at < BROADCAST_WINDOW_MS)
  const mine = log.filter((entry) => entry.from === from)
  const problems = []

  if (targets.length > 1) {
    const lastBroadcast = mine.filter((entry) => entry.broadcast === true).sort((a, b) => b.at - a.at)[0]
    if (lastBroadcast !== undefined) {
      problems.push(
        `10 分钟内已经广播过一次（${Math.round((now - lastBroadcast.at) / 1000)} 秒前，${lastBroadcast.n} 个目标）` +
          ' —— 一次广播 = N 条投递，是最大放大器',
      )
    }
  }
  for (const target of targets) {
    const dup = mine.filter((entry) => entry.to === target.sessionId && now - entry.at < SEND_RATE_WINDOW_MS)
    if (dup.length > 0) {
      problems.push(
        `对「${labelOf(target)}」60 秒内已经发过 ${dup.length} 条（最近 ${Math.round((now - dup[dup.length - 1].at) / 1000)} 秒前）`,
      )
    }
  }
  const lastMinute = mine.filter((entry) => now - entry.at < SEND_RATE_WINDOW_MS)
  if (lastMinute.length >= SEND_RATE_MAX_PER_MINUTE) {
    problems.push(`你在最近 60 秒内已经发了 ${lastMinute.length} 条（上限 ${SEND_RATE_MAX_PER_MINUTE}）`)
  }

  if (problems.length > 0) {
    console.error('⛔ 发送侧熔断（本地限流，防消息风暴）：')
    for (const problem of problems) console.error(`   · ${problem}`)
    console.error('   ⇒ 请合并成一条再发；确认确有必要时加 --force 覆盖。')
    console.error('   （每个收件人都会为每条消息跑一个完整回合 —— 少发一条就是少烧一次。）')
    process.exit(2)
  }

  for (const target of targets) {
    log.push({ at: now, from, to: target.sessionId, kind, broadcast: targets.length > 1, n: targets.length })
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(log.slice(-SEND_RATE_KEEP), null, 2)}\n`, 'utf8')
  } catch {
    /* 记不进去不影响发送本身 */
  }
}

/**
 * 暂停闸门 —— 第三层（定下"排队消息只做记录、延后处理"之后加）。
 *
 * 与限流的分工：
 *   · `enforceSendRate` 管**频率**（发得太密、广播太勤）；
 *   · 这里管**存在性**（这段时间干脆一条都别发）。
 *
 * 为什么限流不够：限流只让"发得快的"变慢，拦不住**五个人互相回执** ——
 * 那天 12:00–16:30，每人净积压 11~24 条，而**没有一条是重复的、也没有一条是无理的**：
 * 每条都正当、都不同，可总量超过了任何人能服务的速度（服务 2~5 回合/10 分钟，
 * 到达 12~17 条/10 分钟）。这种时候唯一的止血是**停一段时间**，不是把每条发得更慢。
 *
 * 语义：
 *   · 状态文件与限流台账同目录：`<studio>/send-pause.json`；
 *   · `until` 到点**自动失效**（不用记得关）；`scope` 缺省/"all" = 全体，也可只点名几个人；
 *   · `--force` 是急诊通道，但**每次越过都会打印一行**——不会被静默吞掉；
 *   · `--inbox` / `--list` 不受影响：暂停只拦"发"，不拦"看"。
 *     这条很关键 —— 暂停期仍要能收报告、判形势，否则等于把眼睛也蒙上。
 */
const PAUSE_DEFAULT_MINUTES = 60

function pauseFile(storeFile) {
  return path.join(path.dirname(storeFile), 'send-pause.json')
}

function readPause(storeFile) {
  const file = pauseFile(storeFile)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    // 绝不静默（同限流台账那条教训）：文件在、却读不出来 ⇒ 有人以为它在生效而它没有。
    if (fs.existsSync(file)) {
      console.error(`⚠️ 暂停状态文件读不出（${file}）：${error instanceof Error ? error.message : String(error)}`)
      console.error('   ⇒ 本次按"没有暂停"处理。若你本意是在暂停期，请检查这个文件。')
    }
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`⚠️ 暂停状态文件形状不对（${file}）：顶层必须是对象。本次按"没有暂停"处理。`)
    return undefined
  }
  const until = typeof parsed.until === 'string' ? Date.parse(parsed.until) : Number.POSITIVE_INFINITY
  if (Number.isFinite(until) && until <= Date.now()) return undefined // 到点自动失效
  return {
    until: Number.isFinite(until) ? until : undefined,
    scope: parsed.scope === undefined ? 'all' : parsed.scope,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    at: typeof parsed.at === 'string' ? parsed.at : undefined,
    by: typeof parsed.by === 'string' ? parsed.by : undefined,
  }
}

function pauseAppliesTo(pause, from) {
  if (pause === undefined) return false
  const scope = pause.scope
  if (scope === 'all' || scope === undefined || scope === null) return true
  if (!Array.isArray(scope)) return true // 形状不对时按"全体"处理：宁可多拦，不可漏拦
  return scope.length === 0 || scope.includes(from)
}

function formatPause(pause, from) {
  if (pause === undefined) return '当前没有暂停：群聊发送正常。'
  const left = pause.until === undefined ? '无期限（要 --unpause 才解除）' : `还剩约 ${Math.max(0, Math.round((pause.until - Date.now()) / 60000))} 分钟`
  const scopeText = pause.scope === 'all' || !Array.isArray(pause.scope) || pause.scope.length === 0 ? '全体成员' : pause.scope.join('、')
  return [
    `⏸ 暂停中：${left}`,
    `   范围：${scopeText}`,
    pause.reason.length > 0 ? `   原因：${pause.reason}` : undefined,
    pause.at !== undefined ? `   设定于：${pause.at}${pause.by !== undefined ? `（${pause.by}）` : ''}` : undefined,
    pauseAppliesTo(pause, from)
      ? `   ⇒ 你（${from}）当前**发不出**：要发加 --force（会留痕），或让任何人跑 --unpause。`
      : `   ⇒ 你（${from}）不在范围内，可以正常发送。`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

function enforceSendPause({ storeFile, from, force }) {
  const pause = readPause(storeFile)
  if (!pauseAppliesTo(pause, from)) return
  if (force === true) {
    console.error('⚠️ 暂停期间用 --force 发出（本次越过会被看见 —— 急诊通道用过这件事本身是信息）。')
    return
  }
  console.error('⛔ 群聊暂停中 —— 这条不会发出。')
  console.error(formatPause(pause, from))
  console.error('   ⇒ 这是 消息风暴后的止血闸门：暂停期**只记录、不回**。')
  console.error('      确有必要：加 --force；或先 --unpause 解除。查看状态：--pause-status')
  process.exit(2)
}

/**
 * 「点名给一个人，却发给了多个人」（以及反过来的"点名的人不在收件人里"）。
 *
 * 为什么单独一条（一次消息泄露事故的复盘）：
 *   那次事故里最伤的不是"广播太多"，而是**一条看起来只给某一个人的消息，好几个人收到了** ——
 *   收件人的"单独对话"里于是出现不属于那段关系的文字（用户的原话："我在和你的单独对话看不到消息"
 *   的反面：单独对话里出现了群聊的话）。
 *   广播在协议里合法，但"首行点名 A、收件人却含 B"是**自相矛盾**的，几乎总是笔误。
 *
 * 判据（刻意收窄，避免误报）：
 *   · 只看**以 `【` 开头**的行（前 4 行内，因为引用行/转达行会排在前面）；
 *   · 且该行里有 `→`。这是我们自己约定的定向标题写法（`【插件维护者 → 接入成员 · …】`、
 *     `【主从守护 → 插件维护者】`），普通正文里的箭头不会被当成标题。
 *
 * **只告警、不阻断**：广播里点名某人是合法写法（"我这条也同步给维护者"），
 * 阻断会误伤真话；但自相矛盾的组合必须被**说出来**，而不是悄悄发出去。
 */
const DIRECTED_LINE_RE = /^【[^】]{0,60}?→\s*([^\s·｜|】,，:：]{1,16})[^】]*】/
const BROADCAST_WORDS = ['全体', '大家', '各位', '所有人', '全员', '所有成员', 'all', '@all']

function directedHeaderOf(body) {
  for (const line of String(body ?? '').split('\n').slice(0, 4)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('【')) continue
    const match = DIRECTED_LINE_RE.exec(trimmed)
    if (match !== null) return { named: match[1].trim(), line: trimmed.slice(0, 80) }
  }
  return undefined
}

function warnIfDirectedMismatch({ body, targets }) {
  if (targets.length === 0) return
  const header = directedHeaderOf(body)
  if (header === undefined || header.named.length === 0) return
  if (BROADCAST_WORDS.some((word) => header.named.includes(word))) return
  const names = targets.map((target) => labelOf(target))
  const hit = names.find((name) => name === header.named || name.includes(header.named) || header.named.includes(name))
  if (hit === undefined) {
    console.error(`⚠️ 定向标题与收件人不符：首行点名「${header.named}」，但它**不在**收件人里（${names.join('、')}）。`)
    console.error(`   命中处：${header.line}`)
    console.error(`   ⇒ 若是笔误，改 --to；若确实要发给别人，把首行的「→ ${header.named}」改成「→ 全体」。`)
    return
  }
  if (names.length > 1) {
    const others = names.filter((name) => name !== hit)
    console.error(`⚠️ 一条点名给「${hit}」的消息，同时发给了 ${others.join('、')}（共 ${names.length} 人）。`)
    console.error(`   命中处：${header.line}`)
    console.error('   ⇒ 对方的"单独对话"里会多出一条不属于那段关系的文字 —— 这正是消息泄露事故的典型形状。')
    console.error('      要么只发给要点名的人，要么把首行改成「→ 全体」再广播。')
  }
}

/** `--to` 支持多个：逗号分隔、或 @all 表示全体（自动去重）。 */
function resolveTargets(members, query, selfSessionId) {  const parts = String(query ?? '')
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const targets = []
  /** `@all` 跳过的退役成员（2026-10-11 用户口径）—— 要报出来，否则"少发给谁"是静默的。 */
  const skippedRetired = []
  for (const part of parts) {
    if (part === '@all' || part.toLowerCase() === 'all') {
      // ★ `@all` **必须排除自己**：否则"给全体发一条"会把我自己的话投进我自己的信箱，
      //   白占我一轮，还看起来像"别人给我发了消息"（实测在成员会话里看到过 `X → X` 的消息）。
      //   想给自己发就显式写 --to <自己的名字>。
      //
      // ★ 2026-10-11 用户口径：**`@all` 还要排除退役成员**。
      //   退役记录（`旧[…]` / `locked===false`）**仍然是成员**，所以原先也在广播目标里 ——
      //   后果是每次交接公告都会把两条 200 万级事件的退役会话叫起来跑一个回合：
      //   实测 20:37:51 一次 7829ms 停顿、物理可用一度掉到 497MB。
      //   而退役记录**不需要**收这些公告（它自己就是被交接的一方，已经被改过名了）。
      //   ⚠️ 只影响 `@all`：**定向**（写名字/短 id）消息照旧可达，历史也不会动。
      for (const member of members) {
        if (selfSessionId !== void 0 && member.sessionId === selfSessionId) continue
        if (isRetired(member)) {
          skippedRetired.push(labelOf(member))
          continue
        }
        if (!targets.includes(member)) targets.push(member)
      }
      continue
    }
    const found = findMember(members, part)
    if (found === undefined) {
      const available = members.map((member) => labelOf(member))
      // 「找不到」与「有歧义」必须分开报：前者是名字写错，后者是**名字不够精确**。
      // 2026-10-08 实测：交接后 `维护` 会同时命中 `维护者` 与 `旧[…]维护者`，
      // 旧逻辑"取第一个命中"会把消息投进**已退役的旧会话**（错投且不易发现）。
      const candidates = findMemberCandidates(members, part)
      if (candidates.length > 1) {
        throw new Error(
          `「${part}」有歧义，命中 ${candidates.length} 位成员：${candidates.map((member) => labelOf(member)).join('、')}` +
            ` —— 请写全名或短 id（例如 ${candidates.map((member) => `#${shortId(member.sessionId)}`).join(' / ')}）。`,
        )
      }
      throw new Error(
        available.length === 0
          ? '工作室里还没有成员：请先在 dsh工作室面板里把会话「提升为成员」。'
          : `没有成员「${part}」。当前成员：${available.join('、')}`,
      )
    }
    if (!targets.includes(found)) targets.push(found)
  }
  if (skippedRetired.length > 0) {
    console.log(
      `  ℹ️ \`@all\` 跳过 ${skippedRetired.length} 位**退役成员**：${skippedRetired.join('、')}` +
        `（2026-10-11 口径：退役记录不收广播，避免把巨型旧会话叫起来；定向消息照旧可达）`,
    )
  }
  return targets
}

/**
 * 一条群聊消息的正文里"它在回复哪一条"（引用行的短 id）。
 *
 * ⚠️ 关键区别：消息头 `｜#xxxxxx` 是**这条消息自己的 id**，而"它回复了谁"只写在
 * **正文首行的引用**里（`> 回复 #c592f5（来自 插件，…）：…`）。
 * 曾经把两者当成同一个东西（拿 header id 去匹配"我发出的 ask"），结果那段状态
 * **从来没有匹配上过** —— 站在成员「站点成员」的位置跑 `--inbox` 才发现：它那条 ask 明明
 * 已经被 ack 了，却一直显示"对方还没给回执"。
 */
function quoteIdOf(body) {
  const match = /^>\s*回复\s*#([0-9a-zA-Z]{4,12})/.exec(String(body ?? '').trim())
  return match !== null ? match[1] : undefined
}

/** 从自己会话的历史 + 本地发送账本里析出"我收到的 / 我发出的"（用于 --inbox）。 */
function foldInbox(selfLabel, events) {
  const incoming = []
  const outgoing = []
  for (const row of events) {
    const event = row !== null && typeof row === 'object' ? row.event : undefined
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const message = event.data
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    const parsed = GROUP_LINE_RE.exec(text)
    if (parsed === null) continue
    const entry = {
      at: typeof event.time === 'number' ? event.time : 0,
      from: parsed[3],
      kind: parsed[2],
      ref: parsed[4],
      // 「这条在回复哪一条」只能从正文引用行取 —— 与消息头自己的 id 是两回事。
      repliesTo: quoteIdOf(parsed[5]),
      body: parsed[5],
    }
    if (parsed[3] === selfLabel) outgoing.push(entry)
    else incoming.push(entry)
  }
  // ★ 关于"回没回"：我用 CLI/工具发出的消息进入的是**对方**的会话，**我自己**的会话里没有记录 ——
  //   所以判定不在这里做（这里只能给出"我收到什么/我自己的会话里发过什么"），
  //   由 `--inbox` 汇总：本地发送账本 + 逐个成员会话扫描 + 本会话的出站消息。
  //   （这个判定缺陷由成员「教练成员」与「站点成员」分别独立复现并报告。）
  return { incoming, outgoing }
}

/** 本地时间戳（HH:MM:SS）。
 * 注意：以前用 toISOString() 输出的是 **UTC**，而成员在自己会话里看到的是本地时间，
 * 两边对不上会被当成两条不同的消息（成员「站点成员」报告）。现在统一成本地时间并显式标注。 */
function stamp(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 当前时区偏移，例如 UTC+8。 */
function zoneLabel() {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 === 0 ? '' : `:${String(abs % 60).padStart(2, '0')}`}`
}

/** 各会话的忙/闲（session.list 的 items 带 running）。拿不到就返回空表。 */
async function fetchRunningMap(baseUrl) {
  try {
    const body = await callRpc(baseUrl, 'session.list', {})
    const items = body.result?.ok ? body.result.value.items : []
    return new Map(items.map((item) => [item.sessionId, item.running === true]))
  } catch {
    return new Map()
  }
}

/**
 * `--reply-to <短id>` 的查找：在我**自己**的会话历史里找带该短 id 的群聊消息，
 * 取它的发送者/时间/首行，拼成一行引用。找不到就抛错（宁可报错也不要发出没有引用的"回复"）。
 */
/**
 * `--reply-to` / `--ack` / `--decline` 的引用解析。
 * 返回 `{ line, from, kind }`：`line` 是要拼进正文的引用行；`from` 是**被引用那条消息的发送者**
 * （`--ack` 靠它自动定收件人，所以不必再写 `--to`）；`kind` 是被引用消息的类型（用来挡"回执回错对象"）。
 *
 * 两级查找：① 自己会话历史（别人发给我的）② 本地发送账本（**我自己发出去的** ——
 * 它们只落在对方会话里，自己会话里查不到。同一个根因在 `--inbox` 上已经踩过一次）。
 */
async function buildQuote(baseUrl, sessionId, shortRef, selfLabel) {
  const body = await callRpc(baseUrl, 'session.history', { sessionId, maxMessages: 300 })
  if (body.result?.ok !== true) throw new Error('读取本会话历史失败，无法解析 --reply-to')
  for (const row of body.result.value.events ?? []) {
    const event = row !== null && typeof row === 'object' ? row.event : undefined
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const message = event.data
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    const parsed = GROUP_LINE_RE.exec(text)
    if (parsed === null || parsed[4] !== shortRef) continue
    const firstLine = parsed[5].split('\n')[0].slice(0, 70)
    return {
      line: `> 回复 #${shortRef}（来自 ${parsed[3]}，${stamp(typeof event.time === 'number' ? event.time : Date.now())}）：${firstLine}\n\n`,
      from: parsed[3],
      kind: parsed[2],
    }
  }
  const mine = readSentLog().find(
    (entry) => entry !== null && typeof entry === 'object' && entry.id === shortRef && entry.from === selfLabel,
  )
  if (mine !== undefined) {
    const at = typeof mine.at === 'string' ? Date.parse(mine.at) : Number.NaN
    const firstLine = typeof mine.title === 'string' && mine.title.length > 0 ? mine.title : '（旧版发出的，账本没存首行）'
    return {
      line: `> 回复 #${shortRef}（我发给 ${mine.to}，${Number.isFinite(at) ? stamp(at) : '时间未知'}）：${firstLine}\n\n`,
      // 引用的是我自己发出的消息 → 没有"回执该发给谁"这回事，收件人必须显式 --to。
      from: undefined,
      kind: typeof mine.kind === 'string' ? mine.kind : '',
    }
  }
  throw new Error(
    `找不到短 id 为 #${shortRef} 的群聊消息（本会话最近 300 条 + 本地发送账本都没有；` +
      '短 id 见 --inbox 或工作室面板的「群聊」页）',
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl =
    typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL.length > 0 ? process.env.DSH_WEB_URL : DEFAULT_WEB_URL
  const callerId = typeof args.from === 'string' && args.from.length > 0 ? args.from : process.env.DSH_SESSION_ID

  // 门禁：`--text` 里含半角双引号 → 直接拒绝并指路 --text-file / --text -（见函数注释）。
  guardTextQuoting(args)

  const store = new StudioStore(resolveStoreFile())
  store.load()
  const members = store.members()
  const selfLabel = (() => {
    const self = callerId === void 0 ? undefined : members.find((member) => member.sessionId === callerId)
    return self !== undefined ? labelOf(self) : callerId === void 0 ? '未知会话' : shortId(callerId)
  })()

  if (args.version === true) {
    let mtime = 'unknown'
    try {
      mtime = fs.statSync(new URL(import.meta.url)).mtime.toISOString()
    } catch {
      /* 忽略 */
    }
    console.log(`studio-say CLI v${CLI_VERSION}    文件时间 ${mtime}`)
    console.log(`能力：${CLI_FEATURES.join(' · ')}`)
    return
  }

  // ── 暂停闸门：--pause-status / --unpause / --pause <分钟> ────────────────────
  //   放在这里（早于所有发送路径、晚于 --version）：读状态与解除**永不被自己拦住**，
  //   否则一暂停就再也解不开。
  const storeFile = resolveStoreFile()
  if (args.pauseStatus === true) {
    console.log(formatPause(readPause(storeFile), selfLabel))
    return
  }
  if (args.unpause === true) {
    const previous = readPause(storeFile)
    fs.rmSync(pauseFile(storeFile), { force: true })
    if (previous === undefined) {
      console.log('当前本来就没有生效中的暂停（状态文件已顺手清理）。')
    } else {
      const scopeText = previous.scope === 'all' || !Array.isArray(previous.scope) ? '全体' : previous.scope.join('、')
      console.log(`✅ 已解除暂停（原范围：${scopeText}）。`)
    }
    console.log('   提醒：暂停只是闸门，它不改变任何人的待办 —— 暂停期收到的消息都还记在各自会话里，')
    console.log('         解除后需要有人把它们**批量**处理掉，而不是一条一条补回执（那正是风暴的成因）。')
    return
  }
  if (args.pause !== void 0) {
    const minutes = Number(args.pause)
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--pause 需要给一个正数（分钟），例如 --pause 60；要解除用 --unpause')
    const rawScope = typeof args.scope === 'string' ? args.scope.trim() : ''
    const scope =
      rawScope.length === 0 || rawScope.toLowerCase() === 'all'
        ? 'all'
        : rawScope
            .split(/[,，]/)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
    const record = {
      at: new Date().toISOString(),
      by: selfLabel,
      until: new Date(Date.now() + minutes * 60_000).toISOString(),
      scope,
      reason: typeof args.reason === 'string' ? args.reason : '',
    }
    fs.mkdirSync(path.dirname(pauseFile(storeFile)), { recursive: true })
    fs.writeFileSync(pauseFile(storeFile), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    console.log('⏸ 已暂停群聊发送：')
    console.log(formatPause(readPause(storeFile), selfLabel))
    console.log(`   默认 ${PAUSE_DEFAULT_MINUTES} 分钟的写法是 --pause ${PAUSE_DEFAULT_MINUTES}；到点自动失效。`)
    console.log('   期间 --inbox / --list 仍可用（只拦"发"，不拦"看"）；任何人可 --unpause。')
    return
  }

  // ── --set-card：**填写自己的成员卡**（角色 + 能力标签；名字与颜色不动）────────────
  //   为什么要有它：角色/能力标签是"别人该把什么活派给你"的唯一线索，但原来只有面板能改，
  //   成员自己填不了。这条命令走**面板同一条宿主路由**（member/upsert），只允许改**自己**。
  if (args.setCard === true) {
    if (callerId === void 0) throw new Error('--set-card 需要知道"我"是谁：请在会话里运行（$DSH_SESSION_ID 缺失时用 --from 指定）')
    const role = typeof args.role === 'string' ? args.role.trim() : ''
    const capsRaw = typeof args.caps === 'string' ? args.caps : ''
    const caps = capsRaw
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    if (role.length === 0 && caps.length === 0) {
      throw new Error('--set-card 至少要给一样：--role "<一行角色>" 和/或 --caps "标签1,标签2,标签3"')
    }
    const payload = { sessionId: callerId }
    if (role.length > 0) payload.role = role.slice(0, 64)
    if (caps.length > 0) payload.caps = caps.slice(0, 8)
    const response = await fetch(`${baseUrl}/api/dsh-studio/member/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`宿主返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
      throw new Error(`写入失败：${JSON.stringify(parsed).slice(0, 300)}`)
    }
    const member = parsed.value !== undefined ? parsed.value.member : undefined
    console.log('✅ 已更新我的成员卡（名字与颜色未改动）：')
    console.log(`   名字：${member !== undefined ? member.alias || '(无别名)' : '(?)'}`)
    console.log(`   角色：${member !== undefined && member.role.length > 0 ? member.role : '(空)'}`)
    console.log(
      `   能力：${member !== undefined && Array.isArray(member.caps) && member.caps.length > 0 ? member.caps.join('、') : '(空)'}`,
    )
    console.log('   别人用 --list 或面板就能看到这张卡。')
    return
  }

  // `--ack/--decline/--progress <短id>` 自带收件人（那条消息的发起者），所以不再强制要求 --to。
  const hasTargetArg =
    args.to !== void 0 || args.ack !== void 0 || args.decline !== void 0 || args.progress !== void 0
  if (
    args.help === true ||
    (args.list !== true && args.inbox !== true && args.setCard !== true && (!hasTargetArg || !hasBodyArg(args)))
  ) {
    console.log(usage(store.state, members))
    process.exit(args.help === true ? 0 : 2)
  }

  // ── --list：成员 + 忙/闲（session.list 的 items 带 running 字段）──
  if (args.list === true) {
    let running = new Map()
    try {
      const body = await callRpc(baseUrl, 'session.list', {})
      const items = body.result?.ok ? body.result.value.items : []
      running = new Map(items.map((item) => [item.sessionId, item.running === true]))
    } catch {
      /* 拿不到忙闲就不标，不影响列成员 */
    }
    console.log(`群：${store.state.activeGroupId}    成员 ${members.length} 位    我：${selfLabel}`)
    for (const member of members) {
      const busy = running.get(member.sessionId)
      // ⚠️ 口径必须写清：这里用的是 `session.list` 的 **running = 正在跑一个回合**，
      //   它**不等于**"队列里没有积压"。CLI 侧读不到队列深度（宿主没有暴露读队列的 RPC，
      //   只有浏览器能通过 `session/queue` 推帧看到），所以这里只说"运行中/空闲"，
      //   不再用含糊的"忙/闲"——成员「教练成员」指出过这两者在别处被当成了同义词。
      console.log(
        `- ${labelOf(member)}  #${shortId(member.sessionId)}  ${busy === true ? '🔴 运行中（消息会排队）' : busy === false ? '🟢 空闲' : '⚪ 状态未知'}` +
          `  ${member.role.length > 0 ? member.role : '（无角色）'}${member.caps.length > 0 ? `  [${member.caps.join(', ')}]` : ''}${member.locked ? '  🔒' : ''}`,
      )
    }
    return
  }

  // ── --inbox：我收到了哪些群聊消息、之后有没有回过 ──
  if (args.inbox === true) {
    if (callerId === void 0) throw new Error('--inbox 需要知道"我"是谁：请在会话里运行（$DSH_SESSION_ID 缺失时用 --from 指定）')
    const INBOX_WINDOW = 300
    const body = await callRpc(baseUrl, 'session.history', { sessionId: callerId, maxMessages: INBOX_WINDOW })
    if (body.result?.ok !== true) throw new Error(`读取本会话历史失败：${JSON.stringify(body.result?.error ?? body).slice(0, 200)}`)
    const folded = foldInbox(selfLabel, body.result.value.events ?? [])
    // ── 发出记录：`{at, to}`，两个来源 ─────────────────────────────────────
    //   ① 本地发送账本 sent.jsonl（最准：带 from/to/at，CLI 与原生工具都记）；
    //   ② 逐个成员扫他们的会话，找「来自我」的消息（兜底；账本是从本轮才开始记的）。
    // 为什么必须带 `to`：只用"之后有没有任意发出"会把"我给 A 回了"错记成"我给 B 也回了"。
    // （成员「教练成员」指出这条判定必须按**同一发送者**算。）
    const sentEntries = readSentLog()
      .filter((entry) => entry !== null && typeof entry === 'object' && entry.from === selfLabel && typeof entry.at === 'string')
      .map((entry) => ({
        at: Date.parse(entry.at),
        to: typeof entry.to === 'string' ? entry.to : '',
        kind: typeof entry.kind === 'string' ? entry.kind : '',
        id: typeof entry.id === 'string' ? entry.id : undefined,
        title: typeof entry.title === 'string' ? entry.title : undefined,
      }))
      .filter((entry) => Number.isFinite(entry.at))
    const scanWindow = 200
    let scannedMembers = 0
    /** 成员会话里"别人发的"群聊消息（用来回答"我发出的 ask 走到哪了"）。 */
    const peerMessages = []
    for (const member of members) {
      if (member.sessionId === callerId) continue
      try {
        const other = await callRpc(baseUrl, 'session.history', { sessionId: member.sessionId, maxMessages: scanWindow })
        if (other.result?.ok !== true) continue
        scannedMembers += 1
        for (const row of other.result.value.events ?? []) {
          const event = row !== null && typeof row === 'object' ? row.event : undefined
          if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
          const messageData = event.data
          if (messageData === null || typeof messageData !== 'object' || !Array.isArray(messageData.content)) continue
          const text = messageData.content
            .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim()
          const parsed = GROUP_LINE_RE.exec(text)
          if (parsed === null) continue
          const at = typeof event.time === 'number' ? event.time : 0
          if (parsed[3] === selfLabel) {
            sentEntries.push({ at, to: labelOf(member), kind: parsed[2], id: parsed[4] })
            continue
          }
          // 这条是**群里的别人**发的。它落在某个成员会话里，说明它发给了那个成员（或广播）。
          // ★ `ref` 在**所有来源里统一表示"它在回复哪一条"**（= 正文引用行的短 id），
          //   消息自己的 id 放 `selfId`。成员「教练成员」读源码指出过：这里原来写的是
          //   `ref: parsed[4]`（自己的 id），于是 `filter(item.ref === ask.id)` 永远比不中，
          //   而兜底又要求 `ref === undefined`（每条都带 id，恒不成立）→ 那一段**恒报"还没回执"**。
          peerMessages.push({
            at,
            from: parsed[3],
            kind: parsed[2],
            selfId: parsed[4],
            ref: quoteIdOf(parsed[5]),
            body: parsed[5],
          })
        }
      } catch {
        /* 单个成员读不到就跳过 */
      }
    }
    // ★ 补一条**关键**来源：**别人回给我的消息落在"我自己"的会话里**（那正是 `foldInbox` 读的那份），
    //   而上面那个扫描循环只扫**其他成员**的会话 —— 于是"我发出的 ask 有没有被回"永远查不到。
    //   实测抓到的现象：站在成员「站点成员」的位置跑 `--inbox`，它那条 ask（#364f13）
    //   明明已经被回了（我回过 `#b0d2d6` 且带 `--reply-to 364f13`），却显示"对方还没给回执"。
    //   `ref` 在**所有 peer 来源里统一表示"它在回复哪一条"**（见上面那处注释与 `quoteIdOf`）。
    peerMessages.push(
      ...folded.incoming.map((item) => ({ at: item.at, from: item.from, kind: item.kind, ref: item.repliesTo, selfId: item.ref, body: item.body })),
    )
    // ★ 去重：**同一条消息会被两个来源各算一次** —— ① 本地账本（我发的时候记的）
    //   ② 扫成员会话时找到的「来自我」的消息。实测这会让"我发出的 ask"列表把同一条 ask 列两遍。
    //   规则：优先保留信息更全的那份（账本条目带首行 title），时间取更早的那个。
    const uniqueSent = new Map()
    for (const entry of sentEntries) {
      const key =
        typeof entry.id === 'string' && entry.id.length > 0
          ? `id:${entry.id}`
          : `${entry.to}|${entry.kind}|${Math.round(entry.at / 1000)}`
      const existing = uniqueSent.get(key)
      if (existing === undefined) {
        uniqueSent.set(key, entry)
        continue
      }
      if (existing.title === undefined && entry.title !== undefined) {
        uniqueSent.set(key, { ...entry, at: Math.min(existing.at, entry.at) })
      }
    }
    sentEntries.length = 0
    sentEntries.push(...uniqueSent.values())
    const { incoming, outgoing } = folded
    // 有证据才敢下"没回过"的结论；一条证据都没有时如实说"无法判定"，避免误导成员重发。
    const hasEvidence = sentEntries.length > 0 || outgoing.length > 0
    // 表头**必须**带这句：底部那行提示在长输出里会被翻过去（成员「站点成员」实测时因为
    // `| Select-Object -First 16` 截断而没看到，一度以为短 id 没生效）。
    console.log(`我：${selfLabel}  (#${shortId(callerId)})    时间均为本地时间（${zoneLabel()}）    每条带 #短id，可 --reply-to 精确引用`)
    if (incoming.length === 0) {
      console.log(`最近 ${INBOX_WINDOW} 条消息里没有别人发给我的群聊消息。`)
      return
    }
    console.log(`最近 ${INBOX_WINDOW} 条消息里有 ${incoming.length} 条别人发给我的群聊消息：\n`)
    // 成员名单：用来区分"这是群成员发的"还是"人类在工作室面板里直接转达的"。
    // 人类从面板发来的消息发送者写的是面板侧的身份（实测看到的是 `我`），它不是成员，
    // 既不该按成员算"回没回"，也不该被误当成某个成员名去 --to。
    const knownLabels = new Set(members.map((member) => labelOf(member)))
    // 账本覆盖范围：只有"发出记录最早那条"之后收到的消息，才谈得上"我有没有回过"。
    // 更早的消息即便当时回过，也没有记录可查 —— 那种情况必须说 ⚪，不能猜 ⚠️。
    // （成员「教练成员」第 (3) 条要求的同一条原则：没证据就别下结论。）
    const coverageStart = sentEntries.length > 0 ? Math.min(...sentEntries.map((entry) => entry.at)) : Number.POSITIVE_INFINITY
    // 回执协议第 ② 层：正式回执（ack 接单 / decline 推掉）。deliver 也算把这条 ask 了结了。
    const RECEIPT_KINDS = ['ack', 'decline', 'deliver']
    let debt = 0
    for (const item of incoming) {
      const isMember = knownLabels.has(item.from)
      // 「回没回」按**同一发送者**算（账本带 to；给 A 回过不该把 B 的旧消息也算成已回）。
      const repliedByLedger = sentEntries.some((entry) => entry.to === item.from && entry.at > item.at)
      // 兜底：账本为空（早期版本发出的没记账）时，退回"自己会话里有没有更晚的发出"。
      const repliedByHistory = sentEntries.length === 0 && outgoing.some((out) => out.at > item.at)
      const replied = repliedByLedger || repliedByHistory
      // 正式回执：这条 ask 之后，我有没有给**同一个发送者**回过 ack/decline/deliver。
      const receiptEntry = sentEntries.find(
        (entry) => entry.to === item.from && entry.at > item.at && RECEIPT_KINDS.includes(entry.kind),
      )
      const covered = Number.isFinite(coverageStart) && item.at >= coverageStart
      const gapSeconds = Number.isFinite(coverageStart) ? Math.max(1, Math.round((coverageStart - item.at) / 1000)) : 0
      // 判定规则抽在 src/protocol.js 的 `inboxVerdict`（纯函数、8 个分支都有单测）——
      // 成员「教练成员」如实报告过 ⚪ 分支在真实会话里无法触发，所以不靠场景、靠单测覆盖。
      const decided = inboxVerdict({
        kind: item.kind,
        isMember,
        replied,
        receiptKind: receiptEntry !== undefined ? receiptEntry.kind : undefined,
        coverageStart,
        at: item.at,
        hasEvidence,
        gapSeconds,
        // 它是回复我某一条的吗？（正文引用行指向我发出的消息 → 一来一回已闭环，不是欠账）
        repliesToMine:
          typeof item.repliesTo === 'string' && sentEntries.some((entry) => entry.id === item.repliesTo)
            ? item.repliesTo
            : undefined,
      })
      const verdict = decided.verdict
      if (decided.debt === true) debt += 1
      const firstLine = item.body.split('\n')[0].slice(0, 70)
      const ref = typeof item.ref === 'string' && item.ref.length > 0 ? ` · #${item.ref}` : ''
      console.log(`[${stamp(item.at)}] ${item.from}${isMember ? '' : '（非成员）'} · ${item.kind}${ref} · ${verdict}`)
      console.log(`    ${firstLine}${item.body.split('\n').length > 1 ? ' …' : ''}`)
    }
    console.log(
      `\n判据：本地发送账本（${sentEntries.length} 条发出记录）` +
        (scannedMembers > 0 ? ` + 扫了 ${scannedMembers} 位成员的会话` : '') +
        `。回消息用 --to "<发起者名>" --kind deliver --text-file <文件>；`,
    )
    console.log('      要精确引用某一条，加 --reply-to <上面那个 #短id>（会自动带一行引用）。')
    if (debt > 0) {
      // 欠账级提醒（用户选定的强度）：不阻断任何操作，但每次 --inbox 都会把欠账摆在你眼前。
      console.log(
        `\n⚠️ 你有 ${debt} 条 ask 还没给正式回执。收到 ask 的正确流程：` +
          '队列排空 → 读完任务 → **动手之前**先回执，再干活：',
      )
      console.log('      node <此文件> --ack <上面那条的 #短id> --text-file <回执.md>      接单（写：我怎么理解 + 计划 + 预计多久）')
      console.log('      node <此文件> --decline <上面那条的 #短id> --text-file <回执.md>  推掉（写：为什么做不了 / 建议找谁）')
      console.log('  收件人会自动 = 那条 ask 的发起者，不用再写 --to。回执是你自己的话，不是机器套话。')
    }

    // ── 我发出的 ask 走到哪了（委托方视角）────────────────────────────────
    // 为什么要有这一段：发起方最痛的不是"送到了没有"（第 ① 层已答），而是
    // **"我批准之后它到底在不在做、做到哪一步"** —— 成员「站点成员」为此自己轮询 git status、
    // 拿文件字节签名当进度、解压 transcript 判断是否还在写，还判断错过一次。
    // 这里把"它对这条 ask 回过什么"摆出来；没有就是没有，不猜。
    const myAsks = sentEntries
      .filter((entry) => entry.kind === 'ask' && typeof entry.id === 'string' && entry.id.length > 0)
      .sort((a, b) => a.at - b.at)
      .slice(-5)
    if (myAsks.length > 0) {
      console.log('\n■ 我发出的 ask（最近 5 条）：对方接没接、做到哪了')
      for (const ask of myAsks) {
        console.log(`  [${stamp(ask.at)}] #${ask.id} → ${ask.to}${ask.title !== undefined ? `  ${ask.title.slice(0, 46)}` : ''}`)
        // ① 引用本条的回答（最硬：--ack/--progress/--deliver 都会自动带引用）
        const referenced = peerMessages.filter((item) => item.ref === ask.id).sort((a, b) => a.at - b.at)
        // ② 没带引用的回答（对方手写消息时可能不带）—— 同一个人、更晚的回话。
        //
        // ⚠️ 不能简单取"最新一条"：实测里它选中了 19:54 那条**队列压力通告**（kind=say），
        //    而真正的回答是 19:42 的 deliver —— 于是显示成"回了一条（可能是别的上下文）"，
        //    把发起方误导成"它没答我的问题"。所以先按**像不像回答**筛，其次才看时间。
        //    （成员「站点成员」在核对时正是拿 19:42 那条 deliver 当反例报上来的。）
        const ANSWER_KINDS = ['ack', 'decline', 'progress', 'deliver']
        const looseAll = peerMessages
          .filter((item) => item.from === ask.to && item.at > ask.at && item.ref === undefined)
          .sort((a, b) => a.at - b.at)
        const looseAnswers = looseAll.filter((item) => ANSWER_KINDS.includes(item.kind))
        const loose = looseAnswers.length > 0 ? looseAnswers : looseAll
        const last = referenced.length > 0 ? referenced[referenced.length - 1] : loose[loose.length - 1]
        if (last === undefined) {
          // ★ 成员「站点成员」指出协议改动带来的新空白：删掉脚本式自动回执后，发起方从 CLI
          //   分不清"它没看到"和"它看到了不想接"。这里**能确定的说死、不能确定的说清**：
          //   投递成功是确定的（这条 ask 在账本里 = 宿主已受理），回执缺失也是确定的；
          //   缺的只有"它读没读"——那只有它自己能答。不猜。
          console.log(
            scannedMembers > 0
              ? '      📨 已送达（宿主已受理）· 但对方**还没给回执**\n' +
                '         ⚠️ 我从 CLI 分不出"它还没读到"还是"它读到了没表态" —— 这正是第 ② 层要补的信息，\n' +
                '            只能等它自己发 ack/decline。要看它是否在处理，去工作室面板看那条消息的状态点\n' +
                '            与「执行中」观测（面板能看到它的工具调用，CLI 这里看不到）。'
              : '      ⚪ 无法判定（这次没读到成员会话）',
          )
          continue
        }
        const chain = referenced.map((item) => item.kind).join(' → ')
        const tag = referenced.length > 0 ? `引用本条：${chain}` : '回了一条（没引用本条，可能是别的上下文）'
        console.log(`      [${stamp(last.at)}] ${last.from} · ${last.kind} · ${tag}`)
        console.log(`      ${last.body.split('\n')[0].slice(0, 80)}`)
        const settled = referenced.some((item) => item.kind === 'deliver')
        if (settled) console.log('      ✅ 已交付（本条 ask 有 deliver 回答）')
        else if (last.kind === 'progress') console.log('      ⏳ 执行中（对方在报进度）')
        else if (last.kind === 'ack') console.log('      📝 已接单，还没报进度、也没交付')
      }
    }
    return
  }

  // ── 回执协议（两段式里的第 ② 层）：--ack 接单 / --decline 推掉 / --progress 执行中 ──
  //   第 ① 层"接受状态（已送达）"由发送侧记录、不发消息，所以这里只管第 ② 层：
  //   由**对方 agent 自己**在"队列排空 → 读完任务 → 动手之前"发出，内容必须是它自己的话。
  const ackRef =
    typeof args.ack === 'string' && args.ack.trim().length > 0
      ? args.ack.trim().replace(/^#/, '')
      : typeof args.decline === 'string' && args.decline.trim().length > 0
        ? args.decline.trim().replace(/^#/, '')
        : typeof args.progress === 'string' && args.progress.trim().length > 0
          ? args.progress.trim().replace(/^#/, '')
          : undefined
  const ackKind =
    typeof args.ack === 'string' && args.ack.trim().length > 0
      ? 'ack'
      : typeof args.decline === 'string' && args.decline.trim().length > 0
        ? 'decline'
        : ackRef !== void 0
          ? 'progress'
          : undefined
  if (typeof args.replyTo === 'string' && args.replyTo.trim().length > 0 && ackRef !== void 0) {
    const other = args.replyTo.trim().replace(/^#/, '')
    if (other !== ackRef) {
      throw new Error(`--reply-to 与 --ack/--decline/--progress 指向了不同的消息（#${other} vs #${ackRef}），只能给一个`)
    }
  }
  const quoteRef =
    ackRef !== void 0
      ? ackRef
      : typeof args.replyTo === 'string' && args.replyTo.trim().length > 0
        ? args.replyTo.trim().replace(/^#/, '')
        : undefined
  const quoteInfo = quoteRef !== void 0 ? await buildQuote(baseUrl, callerId ?? '', quoteRef, selfLabel) : undefined
  const quote = quoteInfo !== undefined ? quoteInfo.line : ''
  if (ackRef !== void 0 && quoteInfo !== undefined && quoteInfo.kind !== 'ask') {
    // 不拦，只提示：回执语义本来是给 ask 的，用在别的类型上多半是引用错了。
    console.log(`⚠️ #${ackRef} 的类型是 ${quoteInfo.kind.length > 0 ? quoteInfo.kind : '未知'}，不是 ask —— 回执通常只用于 ask，仍按你说的发。\n`)
  }

  // 收件人：`--to` 优先；`--ack/--decline` 时允许省略，自动回给"那条 ask 的发起者"。
  const toQuery =
    args.to !== void 0
      ? args.to
      : ackRef !== void 0 && quoteInfo !== undefined && typeof quoteInfo.from === 'string' && quoteInfo.from.length > 0
        ? quoteInfo.from
        : undefined
  const targets = resolveTargets(members, toQuery, callerId)
  if (targets.length === 0) {
    throw new Error(
      ackRef !== void 0
        ? '没能确定发给谁：加 --to <成员名>（--ack/--decline/--progress 只在能解析出"那条消息的发起者"时才自动定收件人）'
        : '缺收件人：用 --to <成员名或会话id>（或 @all）',
    )
  }
  const kind = ackKind !== undefined ? ackKind : KINDS.includes(args.kind) ? args.kind : 'say'
  const rawBody = resolveBody(args)
  if (rawBody === undefined || rawBody.length === 0) {
    // 空回执/空进度没有意义：这几条的存在价值就是"你自己的话"，套话或空话比不发更糟。
    const emptyHint =
      ackKind === 'ack'
        ? '接单回执正文为空 —— 写"我怎么理解这个任务 + 计划 + 预计多久"'
        : ackKind === 'decline'
          ? '推掉回执正文为空 —— 写"为什么做不了 / 建议找谁"'
          : ackKind === 'progress'
            ? '进度正文为空 —— 写"做到哪一步了 + 下一步是什么"（例：3/5 模板改完，正在跑编译）'
            : '正文为空（--text / --text-file / --text - 至少要给一个非空正文）'
    throw new Error(emptyHint)
  }
  // 转达语义：消息头里的「来自」必须保持**真实发送者**（否则对方回复时解析不到成员），
  // 所以"代谁转达"写在正文第一行，显式标明。
  // --reply-to <短id>（或 --ack/--decline 自动带的引用）：拼一行引用放在正文最前。
  const onBehalf =
    typeof args.onBehalfOf === 'string' && args.onBehalfOf.trim().length > 0
      ? `（本消息由「${selfLabel}」代「${args.onBehalfOf.trim()}」转达）\n\n`
      : ''
  const body = quote + onBehalf + rawBody
  // ★ 定向标题自检（L4）：放在这里而不是发送前 —— 这样 `--dry-run` 也会跑它，
  //   谁都能在**不投递任何东西**的前提下验证这条闸门还活着（阳性对照的成本为 0）。
  warnIfDirectedMismatch({ body, targets })
  // ★ 广播标记（方案 A）：一条命令发给**多位**成员时，给所有副本加同一个标记。
  //   作用有二：① 收件人一眼看出"这是广播，不是单独找我"；② 工作室面板据此把 N 张卡**合并成一张**。
  //   放在**正文首行** —— 不能放消息头：头格式被两侧正则严格解析，加第 5 段会让它解析失败。
  const broadcastId = targets.length > 1 ? newGroupMessageId() : undefined
  const wireBody = broadcastId !== undefined ? `〖广播 #${broadcastId}〗\n${body}` : body
  // 每条发出的消息都带一个短 id：对方（人或 agent）可以 --reply-to 它。
  const messageId = newGroupMessageId()
  const group =
    store.state.groups[store.state.activeGroupId] !== undefined
      ? store.state.groups[store.state.activeGroupId].name
      : '我的工作室'

  if (args.dryRun === true) {
    console.log('（--dry-run，不真的发送）')
    console.log(`将投递到：${baseUrl}/api/session.prompt`)
    console.log(`目标（${targets.length}）：` + targets.map((target) => `${labelOf(target)}#${shortId(target.sessionId)}`).join('、'))
    console.log(`发送者：${selfLabel}${callerId !== void 0 ? `  (#${shortId(callerId)})` : ''}`)
    console.log(`模式：queue（排队，不抢占）    类型：${kind}    正文 ${body.length} 字符    短 id #${messageId}`)
    console.log('正文：')
    console.log(groupText(group, kind, selfLabel, wireBody, messageId))
    return
  }

  // ★ 暂停闸门（第三层，最先判）：一条都别发的时段，连限流台账都不该被写。
  enforceSendPause({ storeFile, from: selfLabel, force: args.force === true })

  // ★ 发送侧熔断（第二层闸门，2026-09-22 用户报"消息风暴"后加）：
  //   那天 15 点单小时 273 条、广播占 40%、74% 是信息性消息 ⇒ 每条都消耗对方一个完整回合。
  //   这里只做**本地限流**（零依赖、零重启、可 `--force` 覆盖），作用是让"又发一条"这件事
  //   在动手前先被问一次 —— 它拦不住别人，但能让**这条通路上的每一个人**都受同一套约束。
  enforceSendRate({ storeFile, from: selfLabel, targets, kind, force: args.force === true })

  // 投递回执带上目标当时的忙/闲 —— 委托方据此判断节奏（成员「教练成员」建议）。
  const runningMap = await fetchRunningMap(baseUrl)
  const results = []
  for (const target of targets) {
    const payload = {
      sessionId: target.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: groupText(group, kind, selfLabel, wireBody, messageId) }],
    }
    try {
      const responseBody = await callRpc(baseUrl, 'session.prompt', payload)
      const result = responseBody !== null && typeof responseBody === 'object' ? responseBody.result : undefined
      if (result === undefined || result.ok !== true) {
        const error = result !== undefined && result.error !== undefined ? result.error : undefined
        results.push({ target, ok: false, detail: error !== undefined ? `${error.message}（${error.code}）` : '投递被拒绝' })
      } else {
        appendSentLog({
          at: new Date().toISOString(),
          from: selfLabel,
          to: labelOf(target),
          sessionId: target.sessionId,
          kind,
          id: messageId,
          // 存首行：这样 `--reply-to` 引用自己发出的旧消息时也能带出内容摘要。
          title: body.split('\n')[0].slice(0, 70),
        })
        results.push({ target, ok: true, detail: '已入队' })
      }
    } catch (error) {
      results.push({ target, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const item of results) {
    const busy = runningMap.get(item.target.sessionId)
    // 同上：只说"运行中/空闲"（`session.list.running`），不说含糊的"忙"。
    const status = busy === true ? '当时 🔴 运行中（会排队）' : busy === false ? '当时 🟢 空闲' : '当时状态未知'
    console.log(
      `${item.ok ? '✅' : '❌'} ${labelOf(item.target)}  #${shortId(item.target.sessionId)}  ${item.detail}  · ${status}`,
    )
  }
  const okCount = results.filter((item) => item.ok).length
  console.log(
    `\n共 ${targets.length} 个目标，成功 ${okCount} 个。类型 ${kind}，发送者 ${selfLabel}，本条短 id #${messageId}。\n` +
      '排队语义：对方正在忙就等它这一轮结束再处理，不会打断它。它的回复不会自动回来 —— 需要它显式回一条给你。',
  )
  if (okCount === 0) process.exit(1)
}

main().catch((error) => {
  console.error(`studio-say 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
