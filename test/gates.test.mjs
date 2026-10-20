// 三道闸门的自测：① 暂停闸门 ② 限流闸门 ③ 定向自检（L4）。
//
// 设计原则（为什么这么写）：
//   · **绝不投递任何消息**：DSH_WEB_URL 指向死端口 127.0.0.1:9 当安全网 ——
//     就算闸门失灵，消息也只会撞到连接失败，不会进任何人的会话。
//   · **绝不污染真实状态**：整个测试跑在一个临时 DSH_HOME 里，名册是**自造的**（见下方 FIXTURE_MEMBERS），
//     不读真实工作室文件 ⇒ 暂停文件、限流台账都写在临时目录，真实状态一个字都不动。
//     （一开始想直接跑真实 DSH_HOME，但那样"测试用的暂停"会落进真实状态文件里 ——
//      而且清理用的 --unpause 会把**用户自己设的暂停**一起解掉。这条风险不能接受。）
//   · **每个告警都要有阴性对照**：只验证"该报的时候报了"会漏掉"永远在报"的假闸门。
//     所以定向自检里专门有两条**不该报**的用例（正常单人消息、`→ 全体` 的广播）。
//
// 用法：node test/gates.test.mjs
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAY = path.join(HERE, '..', 'bin', 'say.mjs')
const DEAD_URL = 'http://127.0.0.1:9'
// 完全虚构的发送者：不是任何成员 ⇒ 群聊里的"来自"退化成短 id（abcdef01）。
// 用它当暂停范围，连"测试时误伤真实成员"这种可能性都不存在。
const FAKE_ID = 'session-abcdef01-0000-4000-8000-000000000000'
const FAKE_LABEL = 'abcdef01'

/**
 * **自带名册** —— 这个测试不读任何真实工作室状态。
 *
 * 早先的版本是复制 `<DSH_HOME>/studio/studio.json` 当名册、并直接用真实成员别名写用例，
 * 那有两个毛病：① 换台机器/换个成员名就跑不起来（CI 里必然红）；② 用例正文里出现真实人名。
 * 现在自己造一份最小名册，只含本测试用到的两个别名 ⇒ 任何环境都能跑，且不含任何真实身份。
 */
const FIXTURE_MEMBERS = [
  { sessionId: 'session-11111111-1111-4111-8111-111111111111', alias: '站点维护者', color: 'blue', role: '示例角色', caps: [], locked: true, pinned: true, order: 1 },
  { sessionId: 'session-22222222-2222-4222-8222-222222222222', alias: '维护者', color: 'amber', role: '示例角色', caps: [], locked: true, pinned: true, order: 2 },
]
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gates-'))
fs.mkdirSync(path.join(tempHome, 'studio'), { recursive: true })
{
  const stamp = new Date(0).toISOString()
  const members = Object.fromEntries(
    FIXTURE_MEMBERS.map((member) => [member.sessionId, { ...member, addedAt: stamp, note: '' }]),
  )
  fs.writeFileSync(
    path.join(tempHome, 'studio', 'studio.json'),
    JSON.stringify(
      {
        version: 1,
        activeGroupId: 'main',
        members,
        groups: {
          main: { groupId: 'main', name: '示例工作室', memberIds: FIXTURE_MEMBERS.map((m) => m.sessionId), createdAt: stamp },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}
const labelOfAlias = (alias) => {
  const found = FIXTURE_MEMBERS.find((member) => member.alias === alias)
  if (found === undefined) throw new Error(`用例名册里没有成员「${alias}」—— 加了用例记得同步 FIXTURE_MEMBERS`)
  return alias
}

function run(args) {
  const result = spawnSync(process.execPath, [SAY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: tempHome, DSH_WEB_URL: DEAD_URL, DSH_SESSION_ID: FAKE_ID },
  })
  return { status: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function bodyFile(name, content) {
  const file = path.join(tempHome, `${name}.md`)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

// 限流台账是**跨调用累积**的状态 ⇒ 每个子用例都从"干净的台账"开始，
// 否则前一个用例留下的记录会把后一个用例拦掉（第一次写这个测试就踩了：
// 广播用例被"60 秒内已给站点维护者发过"拦下，看起来像广播闸门生效，其实是同目标闸门）。
const LEDGER = path.join(tempHome, 'studio', 'send-rate.json')
function clearLedger() {
  fs.rmSync(LEDGER, { force: true })
}

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok === true) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ❌ ${name}`)
    if (detail !== undefined) console.log(`       ${String(detail).replace(/\n/g, '\n       ').slice(0, 700)}`)
  }
}

console.log(`临时 DSH_HOME = ${tempHome}\n（真实工作室状态不会被这个测试碰到；投递全部指向 ${DEAD_URL}）\n`)

// ── ① 暂停闸门 ───────────────────────────────────────────────────────────────
console.log('① 暂停闸门')
{
  const before = run(['--pause-status'])
  check('初始状态：没有暂停', before.text.includes('当前没有暂停'), before.text)

  const set = run(['--pause', '1', '--scope', FAKE_LABEL, '--reason', '自测（临时 DSH_HOME）', '--from', FAKE_ID])
  check('--pause 1 设定成功', set.status === 0 && set.text.includes('已暂停'), `exit=${set.status}\n${set.text}`)

  const status = run(['--pause-status'])
  check('--pause-status 显示暂停中', status.text.includes('暂停中') && status.text.includes(FAKE_LABEL), status.text)

  const body = bodyFile('pause', '【测试 → 随便谁】这条**不应该**发出去。')
  const blocked = run(['--to', labelOfAlias('站点维护者'), '--text-file', body, '--from', FAKE_ID])
  check(
    '暂停中发送被拦住（exit 2）',
    blocked.status === 2 && blocked.text.includes('群聊暂停中'),
    `exit=${blocked.status}\n${blocked.text}`,
  )
  check('拦住时**没有**投递成功字样', !blocked.text.includes('已入队'), blocked.text)
  check('拦住时给了 --force / --unpause 出口', blocked.text.includes('--unpause'), blocked.text)

  const ledger = LEDGER
  check('被暂停拦下的一笔**没有**写进限流台账', !fs.existsSync(ledger), `台账文件存在：${ledger}`)

  const forced = run(['--to', labelOfAlias('站点维护者'), '--text-file', body, '--from', FAKE_ID, '--force'])
  check('--force 可越过（且留痕）', forced.text.includes('用 --force 发出'), `${forced.text.slice(0, 400)}`)
  check('越过时投递因死端口失败（安全网生效）', forced.text.includes('❌'), forced.text.slice(0, 400))

  const off = run(['--unpause', '--from', FAKE_ID])
  check('--unpause 解除成功', off.status === 0 && off.text.includes('已解除'), off.text)
  const after = run(['--pause-status'])
  check('解除后回到没有暂停', after.text.includes('当前没有暂停'), after.text)
}

// ── ② 限流闸门（P1）─────────────────────────────────────────────────────────
console.log('\n② 限流闸门（同一目标 60 秒内重复 / 10 分钟内二次广播）')
{
  const first = bodyFile('rate1', '【自测 1】限流用例，第一条。')
  const second = bodyFile('rate2', '【自测 2】限流用例，第二条（应当被拦）。')
  const target = labelOfAlias('站点维护者')
  const other = labelOfAlias('维护者')

  const a = run(['--to', target, '--text-file', first, '--from', FAKE_ID])
  check('第 1 条不被拦（只是投递失败）', !a.text.includes('发送侧熔断'), a.text)
  const b = run(['--to', target, '--text-file', second, '--from', FAKE_ID])
  check('第 2 条（60 秒内同目标）被拦', b.status === 2 && b.text.includes('发送侧熔断') && b.text.includes('60 秒内'), `exit=${b.status}\n${b.text}`)

  clearLedger() // 广播用例从干净台账开始，免得被上面两条的"同目标"记录冒名顶替
  const c = run(['--to', `${target},${other}`, '--text-file', first, '--from', FAKE_ID])
  check('第一次广播放行', !c.text.includes('发送侧熔断'), c.text)
  const d = run(['--to', `${target},${other}`, '--text-file', second, '--from', FAKE_ID])
  check('10 分钟内第二次广播被拦', d.status === 2 && d.text.includes('广播'), `exit=${d.status}\n${d.text}`)
  check('拦广播时给的是广播理由（不是同目标理由）', d.text.includes('10 分钟内已经广播过一次'), d.text)
}

// ── ③ 定向自检（L4）—— 全部用 --dry-run，一条都不投递 ───────────────────────
console.log('\n③ 定向自检（--dry-run，不投递）')
{
  const target = labelOfAlias('站点维护者')
  const other = labelOfAlias('维护者')

  const misdirected = bodyFile('d1', `【插件维护者 → ${target} · 这条只该给一个人】正文。`)
  const r1 = run(['--to', `${target},${other}`, '--text-file', misdirected, '--dry-run', '--from', FAKE_ID])
  check('点名一人却发给多人 → 告警', r1.text.includes('同时发给了'), r1.text)

  const absent = bodyFile('d2', `【插件维护者 → ${other} · 点名的人不在收件人里】正文。`)
  const r2 = run(['--to', target, '--text-file', absent, '--dry-run', '--from', FAKE_ID])
  check('点名的人不在收件人里 → 告警', r2.text.includes('不在'), r2.text)

  // ↓↓ 阴性对照：这两条**必须不报**，否则就是"永远在响的警报"。
  const normal = bodyFile('d3', `【插件维护者 → ${target} · 正常单人消息】正文。`)
  const r3 = run(['--to', target, '--text-file', normal, '--dry-run', '--from', FAKE_ID])
  check('阴性对照：单人消息点名同一人 → 不告警', !r3.text.includes('⚠️ 定向标题'), r3.text)

  const broadcast = bodyFile('d4', '【插件维护者 → 全体 · 广播标题】正文。')
  const r4 = run(['--to', `${target},${other}`, '--text-file', broadcast, '--dry-run', '--from', FAKE_ID])
  check('阴性对照：`→ 全体` 的广播 → 不告警', !r4.text.includes('⚠️ 定向标题'), r4.text)

  const noHeader = bodyFile('d5', '一条没有标题的普通消息，正文里提到 站点维护者 → 维护者 也不该被当成标题。')
  const r5 = run(['--to', `${target},${other}`, '--text-file', noHeader, '--dry-run', '--from', FAKE_ID])
  check('阴性对照：非 `【` 开头行里的箭头 → 不告警', !r5.text.includes('⚠️ 定向标题'), r5.text)
}

fs.rmSync(tempHome, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项${failures.length > 0 ? `，失败 ${failures.length} 项：${failures.join(' / ')}` : '，全部通过 ✅'}`)
process.exit(failures.length > 0 ? 1 : 0)
