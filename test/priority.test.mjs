// dsh-studio — 优先级队列的单测（不需要宿主、不需要重启）。
//
// 分三层验证：
//   1. 判档：什么算"人的消息"、什么算"人发起的群聊"、什么算"成员发起的群聊"；
//   2. 重排：稳定排序、不打乱同档顺序、不改变集合（不丢不重）；
//   3. **插件接线**：用假的 ctx + 假的 Inbox 触发 `agent/inbox/inserted`，
//      验证真的会把 next-turn 搬成期望顺序、且走的是"不发布 canceled"的路径。
//
// 用法：node test/priority.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { PRIORITY, apply, classify, messageText, reorderByPriority } from '../src/priority.js'

const LABELS = new Set(['示例乙', '示例甲', '插件'])
const group = (from, kind, body) => `【群聊·我的工作室｜${kind}｜来自 ${from}】\n${body}`
const msg = (id, text) => ({ id, content: [{ type: 'text', text }] })

test('messageText：拼接所有 text 块，忽略非文本块', () => {
  assert.equal(messageText(msg('a', 'hello')), 'hello')
  assert.equal(messageText({ id: 'b', content: [{ type: 'image' }, { type: 'text', text: 'x' }] }), 'x')
  assert.equal(messageText({ id: 'c' }), '')
  assert.equal(messageText(null), '')
})

test('判档：普通消息 = 用户，成员发的群聊 = memberGroup，非成员发的群聊 = humanGroup', () => {
  assert.equal(classify(msg('1', '帮我修一下这个模板'), LABELS), 'user')
  assert.equal(classify(msg('2', group('示例乙', 'ask', '帮我修一下')), LABELS), 'memberGroup')
  assert.equal(classify(msg('3', group('我', 'say', '你们看一下')), LABELS), 'humanGroup')
  assert.equal(classify(msg('4', group('陌生人', 'say', 'hi')), LABELS), 'humanGroup')
  assert.equal(classify(msg('5', ''), LABELS), 'unknown')
  assert.equal(classify(msg('6', '【群聊格式写坏了 来自 示例乙】'), LABELS), 'user', '前缀不合法时按普通消息处理（不能误判成群聊）')
})

test('档位数值：用户 0 < 人发起的群聊 1 < 成员发起的群聊 2', () => {
  assert.equal(PRIORITY.user, 0)
  assert.equal(PRIORITY.humanGroup, 1)
  assert.equal(PRIORITY.memberGroup, 2)
})

test('重排：把人的消息提到最前，且**同档保持原顺序**', () => {
  const list = [
    msg('m1', group('示例乙', 'deliver', 'A')),
    msg('m2', group('示例甲', 'deliver', 'B')),
    msg('h1', group('我', 'say', 'C')),
    msg('u1', '我打的字'),
    msg('m3', group('示例乙', 'say', 'D')),
  ]
  const { items, changed } = reorderByPriority(list, LABELS)
  assert.equal(changed, true)
  assert.deepEqual(
    items.map((m) => m.id),
    ['u1', 'h1', 'm1', 'm2', 'm3'],
    '用户 → 人发起的群聊 → 成员发起的群聊；成员之间保持 m1 m2 m3 的原顺序',
  )
})

test('重排：已经是正确顺序时 changed=false（不去写 Inbox，避免无意义的持久事件）', () => {
  const list = [msg('u1', '人'), msg('h1', group('我', 'say', '人发的')), msg('m1', group('示例乙', 'say', '机器人发的'))]
  const { items, changed } = reorderByPriority(list, LABELS)
  assert.equal(changed, false)
  assert.deepEqual(items.map((m) => m.id), ['u1', 'h1', 'm1'])
})

test('重排：不丢不重（同一条消息对象原样搬，身份不变）', () => {
  const list = [msg('m1', group('示例乙', 'say', 'x')), msg('u1', 'u'), msg('m2', group('示例乙', 'say', 'y'))]
  const { items } = reorderByPriority(list, LABELS)
  assert.equal(items.length, 3)
  assert.deepEqual(new Set(items.map((m) => m.id)), new Set(['m1', 'u1', 'm2']))
  assert.equal(items[0], list[1], '应当是同一个对象引用，不是复制出来的新消息')
})

test('重排：单条或空队列不动', () => {
  assert.equal(reorderByPriority([], LABELS).changed, false)
  assert.equal(reorderByPriority([msg('u1', 'x')], LABELS).changed, false)
})

// ─────────────────── 插件接线：假 ctx + 假 Inbox ───────────────────

/** 造一个行为与真 Inbox 一致的假件：`nextTurn` 数组 + `mutate` 记录调用。 */
function fakeInbox(messages) {
  return {
    state: { 'next-turn': [...messages], 'next-step': [] },
    get nextTurn() {
      return this.state['next-turn']
    },
    calls: [],
    mutate(target, start, deleteCount, inserted, discardRemoved) {
      this.calls.push({ target, start, deleteCount, discardRemoved, ids: inserted.map((m) => m.id) })
      this.state[target].splice(start, deleteCount, ...inserted)
      return []
    },
  }
}

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(name, listener) {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
    effect(fn) {
      return fn()
    },
  }
}

test('接线：插入之后真的把用户的排队消息提到成员消息之前（且用 mutate/不发布 canceled）', () => {
  const previous = process.env.DSH_STUDIO_PRIORITY
  const previousHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-priority-'))
  process.env.DSH_HOME = home
  process.env.DSH_STUDIO_PRIORITY = '1'
  try {
    // 成员表：让插件能读到"谁是成员"（真实路径也是这个文件）
    fs.mkdirSync(path.join(home, 'studio'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'studio', 'studio.json'),
      JSON.stringify({
        version: 1,
        activeGroupId: 'main',
        members: {
          'session-11111111-1111-1111-1111-111111111111': { sessionId: 'session-11111111-1111-1111-1111-111111111111', alias: '示例乙', color: 'blue', locked: true, pinned: true },
          'session-22222222-2222-2222-2222-222222222222': { sessionId: 'session-22222222-2222-2222-2222-222222222222', alias: '示例甲', color: 'violet', locked: true, pinned: true },
        },
        groups: { main: { groupId: 'main', name: '我的工作室', memberIds: [] } },
      }),
      'utf8',
    )

    const ctx = fakeCtx()
    apply(ctx)
    const handler = ctx.handlers.get('agent/inbox/inserted')
    assert.equal(typeof handler, 'function', '插件必须监听 agent/inbox/inserted')

    const inbox = fakeInbox([
      msg('m1', group('示例乙', 'ask', '请修模板')),
      msg('m2', group('示例甲', 'deliver', '结论如下')),
    ])
    // 人打了一条普通消息进来 → 触发重排
    inbox.state['next-turn'].push(msg('u1', '你先看我这个'))
    handler({ agent: { inbox }, message: inbox.state['next-turn'][2] })

    assert.deepEqual(inbox.nextTurn.map((m) => m.id), ['u1', 'm1', 'm2'], '人的消息必须排到最前')
    assert.equal(inbox.calls.length, 1, '只应该写一次')
    assert.equal(inbox.calls[0].target, 'next-turn')
    assert.equal(inbox.calls[0].discardRemoved, false, '必须走"不发布 canceled"的路径，否则界面会像消息被取消了')
    assert.deepEqual(inbox.calls[0].ids, ['u1', 'm1', 'm2'])

    // 诊断文件应当被写出来（重启后不看日志也能确认它在工作）
    const statusFile = path.join(home, 'studio', 'priority.json')
    assert.equal(fs.existsSync(statusFile), true)
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    assert.equal(status.enabled, true)
    assert.equal(status.reorders, 1)
    assert.deepEqual(status.lastReorder.order, ['user', 'memberGroup', 'memberGroup'])
  } finally {
    if (previous === undefined) delete process.env.DSH_STUDIO_PRIORITY
    else process.env.DSH_STUDIO_PRIORITY = previous
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('接线：已经是正确顺序时不写 Inbox；读不到成员表时不排序', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-priority-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx()
    apply(ctx)
    const handler = ctx.handlers.get('agent/inbox/inserted')

    // 没有成员表 → labels 为空 → 直接返回，不动 Inbox
    const inbox = fakeInbox([msg('m1', group('示例乙', 'say', 'x')), msg('u1', 'y')])
    handler({ agent: { inbox } })
    assert.equal(inbox.calls.length, 0, '读不到成员表时必须完全不干预')

    // 顺序本来就对 → 不写
    fs.mkdirSync(path.join(home, 'studio'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'studio', 'studio.json'),
      JSON.stringify({
        version: 1,
        activeGroupId: 'main',
        members: { 'session-11111111-1111-1111-1111-111111111111': { sessionId: 'session-11111111-1111-1111-1111-111111111111', alias: '示例乙', color: 'blue', locked: true, pinned: true } },
        groups: { main: { groupId: 'main', name: '我的工作室', memberIds: [] } },
      }),
      'utf8',
    )
    const inbox2 = fakeInbox([msg('u1', '人的消息'), msg('m1', group('示例乙', 'say', '成员的'))])
    handler({ agent: { inbox: inbox2 } })
    assert.equal(inbox2.calls.length, 0, '顺序正确时不该产生持久事件')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
