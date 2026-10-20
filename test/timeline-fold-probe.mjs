// 复现"群聊时间线里为什么会出现我们私聊的内容"：
// 把客户端 foldTimelineEvent 的判定规则**原样搬到这里**，喂本会话的真实事件，
// 看它会把哪些条目折进群聊时间线。
// 用法：node test/timeline-fold-probe.mjs [sessionId]
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const sessionId = process.argv[2] ?? process.env.DSH_SESSION_ID
const LINE = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)(?:｜#([0-9a-zA-Z]{4,12}))?】\r?\n?([\s\S]*)$/

async function callRpc(method, payload) {
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `fold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }),
  })
  return await response.json()
}

const textOf = (event) => {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

const body = await callRpc('session.history', { sessionId, maxMessages: 400 })
if (body.result?.ok !== true) {
  console.log('读取失败：', JSON.stringify(body).slice(0, 200))
  process.exit(1)
}

// ★ 完全照抄 src/client.js 的 foldTimelineEvent（含群聊回合标记 inGroupTurn）
let inGroupTurn = false
const folded = []
for (const row of body.result.value.events ?? []) {
  const event = row?.event
  if (event === null || typeof event !== 'object') continue
  if (event.type === 'turn/end') {
    inGroupTurn = false
    continue
  }
  const text = textOf(event)
  if (text.length === 0) continue
  const at = new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString()
  if (event.type === 'user/message') {
    const parsed = LINE.exec(text)
    if (parsed === null) {
      if (!text.startsWith('【群聊')) inGroupTurn = false
      continue
    }
    inGroupTurn = true
    folded.push({ at, direction: 'out', kind: parsed[2], author: parsed[3], text: parsed[5].split('\n')[0].slice(0, 90) })
    continue
  }
  if (event.type !== 'assistant/message' || inGroupTurn !== true) continue
  folded.push({ at, direction: 'in', kind: 'chat', author: '(本会话主人)', text: text.split('\n')[0].slice(0, 90) })
}

console.log(`会话 ${sessionId}`)
console.log(`照抄客户端折叠规则后，会被折进「群聊时间线」的条目：${folded.length} 条\n`)
for (const item of folded.slice(-24)) {
  const arrow = item.direction === 'out' ? '发给本会话' : '本会话的回答'
  console.log(`[${item.at.slice(11, 19)}Z] ${arrow}  kind=${item.kind}  from=${item.author}`)
  console.log(`    ${item.text}`)
}
const mine = folded.filter((item) => item.direction === 'in')
console.log(`\n其中「本会话的回答」${mine.length} 条 —— 这些就是会被显示成群聊内容的本会话输出。`)
