// dsh-studio — 宿主工具半边：给 **agent** 用的群聊接口。
//
// 为什么单独一个模块：宿主插件条目一旦被 loader 加载就不再重新 import（cordis-plugin-hmr 只监视
// profile 目录，而本包源码在 profile 目录之外经 junction 进入），所以把工具做成包的**另一个子路径入口**
// （`dsh-studio/tools`），就能用 patch 层新增一行让它立刻生效，而不必重启主星。
//
// 注册语义：`ctx.tools.register(...)` 在**宿主根上下文**上调用 = 注册成**全局工具**，
// 因此工作室里的每个成员会话（以及你自己的会话）都能看到并使用它。
//
// 只做一件事：把一句话按群聊前缀投递给另一个成员会话。
// 走的是宿主自己的 `agent.followup()` —— 与 apiproxy 的 `session.prompt(mode:"queue")` 同一条路，
// 因此**排队、不抢占**对端进行中的 turn。

import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, StudioStore } from './store.js'
import { appendSentLog, findMember, findMemberCandidates, groupText, labelOf, newGroupMessageId, resolveStoreFile, shortId } from './protocol.js'

export const name = 'dsh-studio/tools'
export const inject = ['tools', 'agents']

/** 拿活着的 agent；对端是冷会话就按身份 resume 一次（与 apiproxy 的 turnAgentFor 同语义）。 */
async function ensureAgent(ctx, sessionId) {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live
  const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
  return handle.agent
}

/**
 * ── P2 · 宿主侧反压（三条规则，2026-09-22 用户指示"P2 压成 3 条"后落地）──────────
 *
 * 背景：09-22 的消息风暴里，**到达速率是服务能力的 3~6 倍**（12~17 条/10 分钟 vs 2~5 回合/10 分钟），
 * 每条都让对方跑一个完整回合 ⇒ 队列只涨不落。发送侧熔断（P1，在 CLI 里）只约束**走 CLI 的那条通路**；
 * 这里补的是**宿主侧、在投递那一刻**的闸门。
 *
 * 三条规则（就是"三条"，不是"阈值 3"之外的别的东西 —— 两条理解在这里重合）：
 *   ① **深度闸**：目标 `inbox.nextTurn` 里未消费消息 **≥ 3 条 ⇒ 不投**，并把深度回告给调用方；
 *   ② **同源合并**：若目标队列里已有**同一发送者**的未消费消息 ⇒ 用 `inbox.replace` 把那条**替换**为
 *      "旧内容 + 分隔线 + 新内容"，**不新增队列项**（这才是真的合并，而不是又塞一条）；
 *   ③ **可审计**：投递结果一律回报 `pending`（投递前目标队列深度）与 `merged`（是否走了合并）。
 *
 * ⚠️ **覆盖范围要如实写**：本闸门在 `studio_say`（原生工具）这条通路上生效。
 * **CLI 通路**由 `bin/say.mjs` 的 P1 熔断负责（CLI 读不到宿主队列深度，做不了深度闸）；
 * **面板通路**若要覆盖，需要另加宿主路由钩子（未做，记为待办）。
 */
const BACKPRESSURE_MAX_PENDING = 3
const MERGE_MAX_CHARS = 24000

/** 一条 pending 消息是不是"同一个发送者发来的"（判据＝群聊头里的「来自 <sender>｜」，不猜内容）。 */
function pendingFromSender(message, sender) {
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  const text = blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return { text, hit: text.includes(`｜来自 ${sender}｜`) }
}

/**
 * 投递前的反压判定。**只读、不改队列**（合并动作由调用方在通过判定后执行）。
 * @returns {{decision:'deliver'|'merge'|'reject', pending:number, mergeTarget?:object, reason?:string}}
 */
function backpressureVerdict(agent, sender, newText) {
  const inbox = agent !== undefined && agent !== null ? agent.inbox : undefined
  const pendingMessages = inbox !== undefined && Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []
  const pending = pendingMessages.length
  if (pending >= BACKPRESSURE_MAX_PENDING) {
    return { decision: 'reject', pending, reason: `对方信箱里已有 ${pending} 条未处理消息（阈值 ${BACKPRESSURE_MAX_PENDING}）` }
  }
  // 同源合并：取**最后一条**同一发送者的 pending 消息（新的覆盖旧的语义最贴近"我刚发的补充"）。
  for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
    const probe = pendingFromSender(pendingMessages[index], sender)
    if (!probe.hit) continue
    const combined = `${probe.text}\n\n— — — —（同一发送者的后续，已合并）— — — —\n\n${newText}`
    if (combined.length > MERGE_MAX_CHARS) break // 太长就不合并，宁可新投一条（由深度闸兜底）
    return { decision: 'merge', pending, mergeTarget: { message: pendingMessages[index], text: combined } }
  }
  return { decision: 'deliver', pending }
}

/**
 * ── P5 · 重启后唤醒（重启后唤醒的僵局）─────────────────────────
 *
 * 现场：`primary-out.log` 显示重启后队列**被还原**（`已重排 next-turn：… memberGroup ×28`），
 * 但**除我之外没有任何成员有过 `turn/start`** ⇒ 「空闲 + 队列非空」的僵局。
 * 机理（读 `dsh-agent-loop` 源码）：`turn()` 结尾确实会自抽干（`if (!this.inbox.hasPending) return false;`），
 * 但**第一脚必须有人踩** —— `kick()` 只由 `send()`→`wakeDriver()` 触发，而**还原只塞消息、不唤醒**。
 *
 * ⇒ 本补丁：启动后扫一遍**活着的成员会话**，对"空闲且队列非空"的各唤醒一次。
 *
 * 三条保守边界（防止"唤醒即风暴"）：
 *   · **串行**：一次只唤醒一个，间隔 `spacingMs`；
 *   · **上限**：整轮最多唤醒 `maxWakes` 个；
 *   · **超长不碰**：队列长度 > `maxPending` 的**只记日志、不唤醒**（留给人和仪表判断）。
 */
const WAKE_AFTER_MS = 10_000
const WAKE_SPACING_MS = 45_000
const WAKE_MAX = 3
const WAKE_MAX_PENDING = 40

function scheduleWakeScan(ctx, store, log) {
  let wakes = 0
  const result = {
    at: new Date().toISOString(),
    pid: typeof process !== 'undefined' && Number.isFinite(process.pid) ? process.pid : null,
    checked: 0,
    // ⚠️ **必须落盘**（2026-09-22 19:3x 实测）：这一半（`dsh-studio/tools`）的 `log`/`console`
    //    **不会出现在 `primary-out.log` 里** —— 我加的"总是打印一行"打在了一个**读不到的地方**。
    //    ⇒ 于是这里改成**写文件**：`<studio>/wake-scan.json`，与 `tools-half.json` 同目录、同样可读。
    //    （这正是"把口径做成字段"那条：**日志会丢，文件不会**。）
    candidates: [],
    woke: [],
    skipped: [],
  }
  const flush = () => {
    try {
      const file = path.join(path.dirname(resolveStoreFile()), 'wake-scan.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    } catch {
      /* 写不进去不影响唤醒本身 */
    }
  }
  const scan = () => {
    let agents
    try {
      agents = ctx.agents
    } catch {
      result.note = 'ctx.agents 不可用'
      flush()
      return
    }
    if (agents === undefined || typeof agents.get !== 'function') {
      result.note = 'agents.get 不是函数（API 变了？）'
      flush()
      return
    }
    store.load()
    const members = store.members()
    result.checked = members.length
    const candidates = []
    for (const member of members) {
      const agent = agents.get(member.sessionId)
      if (agent === undefined || agent === null) {
        result.skipped.push(`${labelOf(member)}：冷会话（不在内存里）`)
        continue
      }
      if (agent.status !== 'idle') {
        result.skipped.push(`${labelOf(member)}：正在跑（它自己会在回合边界继续抽）`)
        continue
      }
      const inbox = agent.inbox
      const pending = inbox !== undefined && Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0
      if (pending === 0) continue
      if (pending > WAKE_MAX_PENDING) {
        // ⚠️⚠️ **不要再"跳过"**（2026-09-22 19:3x 实测的**交互缺陷**）：
        //   现场：维护者 空闲 + 队列 **52 条** ⇒ 被这条「>40 就跳过」的保护规则跳过，
        //   而 P2 的深度闸又**拒绝一切新投递** ⇒ **它既收不到新消息、也没人唤醒它 ⇒ 被冻结。**
        //   两条规则各自都"合理"，**合起来**却造出一个死结。
        //   ⇒ 修法：**仍然唤醒**（唤醒是抽干积压的唯一机制），只把代价说出来。
        //   风暴风险由 P1 的发送侧熔断兜住（每人 ≤6 条/分钟、10 分钟内不得二次广播）。
        log(`⚠️ [dsh-studio/反压] 「${labelOf(member)}」空闲但队列 **${pending}** 条（> ${WAKE_MAX_PENDING}）⇒ **仍然唤醒**（否则它会一直被卡住）；注意这一次的算力开销`)
      }
      candidates.push({ member, agent, pending })
    }
    result.candidates = candidates.map((item) => `${labelOf(item.member)}:${item.pending}`)
    flush()
    if (candidates.length === 0) {
      // "没事做"也留痕（文件里 checked/candidates/skipped 就是分母）。
      log(`[dsh-studio/反压] 启动后扫描：检查了 ${result.checked} 位成员，「空闲且有积压」的候选 0 个 ⇒ 不需要唤醒`)
      return
    }
    log(`[dsh-studio/反压] 重启后唤醒：发现 ${candidates.length} 个「空闲 + 队列非空」的成员会话（本轮最多处理 ${WAKE_MAX} 个）`)
    const step = () => {
      if (wakes >= WAKE_MAX || candidates.length === 0) {
        flush()
        return
      }
      const next = candidates.shift()
      if (typeof next.agent.wakeDriver !== 'function') {
        result.skipped.push(`${labelOf(next.member)}：该 agent 没有 wakeDriver（API 变了？）`)
        log(`⚠️ [dsh-studio/反压] 该 agent 没有 wakeDriver（API 变了？）⇒ 跳过「${labelOf(next.member)}」`)
        flush()
        return
      }
      try {
        next.agent.wakeDriver()
        wakes += 1
        result.woke.push(`${labelOf(next.member)}:${next.pending}`)
        log(`✅ [dsh-studio/反压] 已唤醒「${labelOf(next.member)}」（队列 ${next.pending} 条）—— 它会连续跑完整个积压`)
      } catch (error) {
        result.skipped.push(`${labelOf(next.member)}：唤醒失败 ${String(error)}`)
        log(`⚠️ [dsh-studio/反压] 唤醒「${labelOf(next.member)}」失败：${String(error)}`)
      }
      flush()
      if (candidates.length > 0 && wakes < WAKE_MAX) setTimeout(step, WAKE_SPACING_MS)
    }
    step()
  }
  const timer = setTimeout(scan, WAKE_AFTER_MS)
  return () => clearTimeout(timer)
}

export function apply(ctx) {
  const store = new StudioStore(resolveStoreFile())
  store.load()

  const readStore = () => {
    // 每次调用都重读，这样面板里刚改的成员立刻可用（文件很小）。
    store.load()
    return store
  }

  const groupNameOf = (state) => {
    const group = state.groups[state.activeGroupId] ?? state.groups[DEFAULT_GROUP_ID]
    return group !== undefined && typeof group.name === 'string' && group.name.length > 0 ? group.name : DEFAULT_GROUP_NAME
  }

  const roster = (state) => store.members().map((member) => labelOf(member))

  const membersTool = defineTool({
    name: 'studio_members',
    description:
      '列出 dsh工作室（跨会话群聊）里的成员：每个成员的显示名、角色与能力标签、会话 id、是否在运行。' +
      '要和别的会话说话前先用它确认对方叫什么；`studio_say` 的 `to` 就填这里的名字。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                role: { type: 'string', required: true },
                capabilities: { type: 'array', required: true, items: { type: 'string' } },
                sessionId: { type: 'string', required: true },
                locked: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `群「${value.group}」共 ${value.members.length} 位成员：\n` +
            value.members
              .map((member) => `- ${member.name}${member.role.length > 0 ? `（${member.role}）` : ''} #${shortId(member.sessionId)}`)
              .join('\n'),
        },
      ],
    },
    execute() {
      const state = readStore().state
      return Promise.resolve({
        group: groupNameOf(state),
        members: store.members().map((member) => ({
          name: labelOf(member),
          role: member.role,
          capabilities: [...member.caps],
          sessionId: member.sessionId,
          locked: member.locked,
        })),
      })
    },
  })

  const sayTool = defineTool({
    name: 'studio_say',
    description:
      '向 dsh工作室（跨会话群聊）里的另一位成员发一条消息。' +
      '消息会作为一条带群聊标记的用户消息进入对方会话，对方用它**自己的上下文和工具**处理，' +
      '它的回复会回到**你的**会话里（以及工作室面板的群聊时间线上）。' +
      '投递是排队语义：如果对方正在忙，消息会等它当前这一轮结束后再处理，**不会打断它**。' +
      '用 `studio_members` 查对方的名字；`to` 填成员显示名或会话 id。' +
      '这是一条真实的、会被对方认真对待的请求，请像给人写消息一样写清楚你的诉求与期望的产出。',
    parameters: {
      to: { type: 'string', required: true, description: '收件成员：显示名（如「示例甲」）或会话 id' },
      text: { type: 'string', required: true, description: '消息正文' },
      kind: {
        // 可选参数 = **不写 `required` 键**。DSH 的入参 DSL 里 `required` 一旦出现就必须是 `true`，
        // 写成 `required: false` 会让 defineTool 抛 JsonSchemaError ⇒ 插件树挂载失败 ⇒ 主星启动即崩
        // （一次真实故障：曾导致整机连环崩溃，且自检因"配置导出看着是绿"而无法自愈）。
        type: 'string',
        enum: ['say', 'ask', 'deliver', 'share'],
        description: '消息类型：say 普通传话（默认）；ask 请对方帮忙/委托；deliver 交付产物；share 共享资源或申请资源',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          toName: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          queued: { type: 'boolean', required: true },
          targetRunning: { type: 'boolean', required: true },
          targetHadPending: { type: 'boolean', required: true },
          // P2 反压（2026-09-22）：把"投递前目标队列有多深"和"是否走了同源合并"做成**必报字段** ——
          // 规则可以忘，字段跑不掉（这是维护者那条"把口径做成字段"的直接应用）。
          pending: { type: 'number', required: true },
          merged: { type: 'boolean', required: true },
          // ⚠️ **拒投时必须带上理由** —— 这一条是我第一次上线时**漏掉的**：
          //    `reject` 分支返回了 `reason`，而 schema 没声明它 ⇒ `additionalProperties: false` 判为
          //    "invalid output" ⇒ 调用方看到的是**框架的报错**，而不是那句"⛔ 未投递…排队深度 N"。
          //    ⇒ 教训：**schema 是契约，拒投路径也是契约的一部分**
          //    （只验"闸门拦住了"不够，还要验"拦住之后说了什么" —— 同"该放行时放得行"那条）。
          //    可选字段 = **不写 `required` 键**（写成 `required: false` 会让 defineTool 抛 JsonSchemaError）。
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.delivered === false
            ? `⛔ 未投递给「${value.toName}」：${value.reason}。` +
              `⇒ 两条解开办法：① 等它自己排空；② **让别人用 CLI 发一条**（bin/say.mjs 走另一条通路、绕过本闸门）把它**叫醒**，它会连续跑完整个积压。`
            : `已把消息投递给「${value.toName}」(#${shortId(value.sessionId)})。` +
              (value.merged ? '（同一发送者的前一条尚未处理，本条已与之**合并**，没有新增队列项。）' : '') +
              (value.queued
                ? `对方当前在忙，消息已在它的信箱里排队（排队深度 ${value.pending} 条），等这一轮结束才处理。`
                : `对方已收到（排队深度 ${value.pending} 条），会用它自己的上下文作答。`) +
              '它的回复会作为一条用户消息回到你这个会话。',
        },
      ],
    },
    async execute(args, exec) {
      const store = readStore()
      const members = store.members()
      const target = findMember(members, args.to)
      if (target === undefined) {
        const available = roster(store.state)
        // 与 CLI 侧同口径：「找不到」与「有歧义」分开报（见 protocol.findMember 注释）。
        const candidates = findMemberCandidates(members, String(args.to))
        if (candidates.length > 1) {
          throw new Error(
            `「${String(args.to)}」有歧义，命中 ${candidates.length} 位成员：` +
              `${candidates.map((member) => labelOf(member)).join('、')}` +
              ` —— 请写全名或短 id（例如 ${candidates.map((member) => `#${shortId(member.sessionId)}`).join(' / ')}）。`,
          )
        }
        throw new Error(
          available.length === 0
            ? '工作室里还没有任何成员：请先在 dsh工作室面板里把会话「提升为成员」。'
            : `工作室里没有成员「${String(args.to)}」。当前成员：${available.join('、')}`,
        )
      }
      const caller = exec.agent
      if (caller === undefined) throw new Error('studio_say 需要一个发起会话（没有 agent 上下文的调用无法确定发送者）')
      const callerMember = members.find((member) => member.sessionId === String(caller.id))
      const from = callerMember !== undefined ? labelOf(callerMember) : shortId(String(caller.id))
      const kind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : 'say'
      const messageId = newGroupMessageId()
      const text = groupText(groupNameOf(store.state), kind, from, String(args.text), messageId)
      const agent = await ensureAgent(ctx, target.sessionId)
      // ⚠️ 两个信号**语义不同**，都要报、且要分开报（成员「示例甲」指出 CLI 与原生工具
      //    口径不一致：CLI 用 `session.list.running`＝"正在跑一个回合"，
      //    这里原来用 `inbox.hasPending`＝"有待处理消息未消费"）。
      //    宿主侧两个都能读到，所以这里一起给；CLI 侧读不到 hasPending（没有读队列的 RPC），
      //    所以 CLI 只报 running，并在 --list 文案上写明口径。
      const running = agent.status === 'running'
      const hasPending = agent.inbox !== undefined && agent.inbox.hasPending === true

      // ── P2 宿主侧反压：投递**之前**判一次（三条规则，见文件头 BACKPRESSURE_* 注释）──
      const verdict = backpressureVerdict(agent, from, text)
      if (verdict.decision === 'reject') {
        // ⚠️⚠️ **拒投 ≠ 放着不管**（2026-09-22 19:2x 实测发现的缺陷，当场修）：
        //   现场：某个成员**空闲但队列 ≥3 条**（`ensureAgent` 恢复会话时把队列一并还原了）
        //   ⇒ 我的拒投意味着**它永远不会被唤醒** ⇒ 深度闸反而**把卡住的队列永久卡住**。
        //   ⇒ 正确做法：**不投，但把它叫醒**（用与 P5 同一把钥匙 `wakeDriver`）——
        //     这样积压会被它自己连续抽干，而新消息也不占用队列。
        if (agent.status === 'idle' && typeof agent.wakeDriver === 'function') {
          try {
            agent.wakeDriver()
            logLine(`[dsh-studio/反压] 拒投给「${labelOf(target)}」（队列 ${verdict.pending} 条）并**顺手唤醒**它 ⇒ 让积压排空`)
          } catch (error) {
            logLine(`⚠️ [dsh-studio/反压] 拒投后唤醒「${labelOf(target)}」失败：${String(error)}`)
          }
        }
        return {
          delivered: false,
          reason: verdict.reason,
          toName: labelOf(target),
          sessionId: target.sessionId,
          queued: hasPending,
          targetRunning: running,
          targetHadPending: hasPending,
          pending: verdict.pending,
          merged: false,
        }
      }
      if (verdict.decision === 'merge') {
        // 真合并：**替换**队列里那条同源消息，而不是再追加一条（否则等于把风暴换个名字）。
        const replaced = agent.inbox.replace(
          verdict.mergeTarget.message.id,
          createUserMessage({
            content: [{ type: 'text', text: verdict.mergeTarget.text }],
            source: { kind: 'user' },
          }),
        )
        if (replaced === true) {
          appendSentLog({ at: new Date().toISOString(), from, to: labelOf(target), sessionId: target.sessionId, kind })
          return {
            delivered: true,
            toName: labelOf(target),
            sessionId: target.sessionId,
            queued: hasPending,
            targetRunning: running,
            targetHadPending: hasPending,
            pending: verdict.pending,
            merged: true,
          }
        }
        // replace 失败（消息 id 对不上等）⇒ **退回正常投递**，并由深度闸继续兜底；绝不静默丢弃。
      }

      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
      // 记一笔"我发过什么"：这条消息只出现在**对方**的会话里，不记的话 --inbox 无法判断回没回。
      appendSentLog({ at: new Date().toISOString(), from, to: labelOf(target), sessionId: target.sessionId, kind })
      return {
        delivered: true,
        toName: labelOf(target),
        sessionId: target.sessionId,
        // 保留 `queued` 字段名（向后兼容），语义明确成"投递时它已有待处理消息"。
        queued: hasPending,
        targetRunning: running,
        targetHadPending: hasPending,
        pending: verdict.pending,
        merged: false,
      }
    },
  })

  ctx.effect(() => ctx.tools.register(membersTool), 'dsh-studio: studio_members tool')
  ctx.effect(() => ctx.tools.register(sayTool), 'dsh-studio: studio_say tool')

  // ── P5 重启后唤醒（三条保守边界，见文件头 WAKE_* 注释）──
  const logLine = (message) => {
    if (ctx.logger !== void 0 && typeof ctx.logger.info === 'function') ctx.logger.info(message)
    else console.log(message)
  }
  ctx.effect(() => scheduleWakeScan(ctx, store, logLine), 'dsh-studio: 重启后唤醒（P5）')

  const line = `[dsh-studio/tools] tools half loaded — data=${store.file} members=${store.members().length}`
  if (ctx.logger !== void 0 && typeof ctx.logger.info === 'function') ctx.logger.info(line)
  else console.log(line)

  // 加载标记：宿主条目"有没有被加载/重载"从外部看不到（宿主日志不可读），写一个时间戳文件便于自检。
  try {
    const marker = path.join(path.dirname(resolveStoreFile()), 'tools-half.json')
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(
      marker,
      `${JSON.stringify(
        {
          loadedAt: new Date().toISOString(),
          pid: process.pid,
          tools: [membersTool.name, sayTool.name],
          members: store.members().map((member) => ({ name: labelOf(member), sessionId: member.sessionId })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch (error) {
    if (ctx.logger !== void 0 && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[dsh-studio/tools] marker write failed: ${String(error)}`)
  }
}
