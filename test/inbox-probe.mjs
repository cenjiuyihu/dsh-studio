// 诊断工具：把某个会话历史里所有「群聊格式」的消息原文打出来，用于核对 --inbox 的 from 归属、
// 短 id 是否落在消息头里、以及"发出的话为什么不在自己会话里"这类问题。
// 用法：node test/inbox-probe.mjs [sessionId]        （默认用 $DSH_SESSION_ID，即跑它的那个会话）
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const sessionId = process.argv[2] ?? process.env.DSH_SESSION_ID

async function callRpc(method, payload) {
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload }),
  })
  return await response.json()
}

const body = await callRpc('session.history', { sessionId, maxMessages: 300 })
if (body.result?.ok !== true) {
  console.log('读取失败：', JSON.stringify(body).slice(0, 400))
  process.exit(1)
}
const LINE = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)(?:｜#([0-9a-zA-Z]{4,12}))?】\r?\n?([\s\S]*)$/
let index = 0
for (const row of body.result.value.events ?? []) {
  const event = row?.event
  if (event?.type !== 'user/message') continue
  const text = (event.data?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  const parsed = LINE.exec(text)
  if (parsed === null) continue
  index += 1
  const at = typeof event.time === 'number' ? new Date(event.time).toLocaleString('sv-SE') : '?'
  console.log(`#${index}  [${at}]  群=${parsed[1]}  类型=${parsed[2]}  来自=[${parsed[3]}]  短id=${parsed[4] ?? '(无)'}`)
  console.log(`     首行：${parsed[5].split('\n')[0].slice(0, 80)}`)
  console.log(`     原文前 120 字：${JSON.stringify(text.slice(0, 120))}`)
}
console.log(`\n共 ${index} 条群聊格式消息（会话 ${sessionId}）`)
