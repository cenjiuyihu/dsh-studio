// dsh-studio 单元测试（纯 Node，无浏览器）。
// 覆盖 src/store.js 的纯函数与文件往返；UI/锁位属于端到端范畴，见 README 的验证章节。
//
//   node test/store.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  StudioStore,
  DEFAULT_GROUP_ID,
  emptyState,
  isLocked,
  memberRemove,
  memberUpsert,
  newMember,
  nextOrder,
  normalizeState,
  sortedMembers,
} from '../src/store.js'

test('emptyState：结构完整且默认群存在', () => {
  const state = emptyState()
  assert.equal(state.version, 1)
  assert.equal(state.activeGroupId, DEFAULT_GROUP_ID)
  assert.deepEqual(state.members, {})
  assert.deepEqual(state.groups[DEFAULT_GROUP_ID].memberIds, [])
})

test('newMember：默认锁定（归档在 DSH 里不可逆）', () => {
  const member = newMember('session-a', {}, '2026-01-01T00:00:00.000Z', 3)
  assert.equal(member.sessionId, 'session-a')
  assert.equal(member.locked, true, '新成员必须默认锁定')
  assert.equal(member.pinned, false)
  assert.equal(member.order, 3)
  assert.deepEqual(member.caps, [])
  assert.equal(member.addedAt, '2026-01-01T00:00:00.000Z')
})

test('newMember：caps 去重并裁剪长度', () => {
  const member = newMember('session-a', { caps: ['a', 'a', '  b  ', '', 'x'.repeat(80)] })
  assert.deepEqual(member.caps, ['a', 'b', 'x'.repeat(40)])
})

test('normalizeState：非对象输入退化为空状态', () => {
  for (const input of [null, undefined, 42, 'text', true]) {
    const state = normalizeState(input)
    assert.deepEqual(state.members, {})
  }
})

test('normalizeState：坏字段被丢弃，缺字段被补默认值', () => {
  const state = normalizeState({
    version: 'nonsense',
    activeGroupId: '   ',
    members: {
      'session-a': { sessionId: 'session-a', alias: '  教练成员  ', locked: 'yes', pinned: 1, order: 'x', caps: 'nope' },
      'session-b': null,
      '': { alias: 'no id' },
    },
  })
  assert.equal(state.activeGroupId, DEFAULT_GROUP_ID)
  assert.deepEqual(Object.keys(state.members), ['session-a'])
  const member = state.members['session-a']
  assert.equal(member.alias, '教练成员', 'alias 应被 trim')
  assert.equal(member.locked, true, '非布尔 locked 回落到默认锁定')
  assert.equal(member.pinned, false, '非布尔 pinned 回落到 false')
  assert.equal(member.order, 0)
  assert.deepEqual(member.caps, [])
})

test('normalizeState：members 的 key 与 sessionId 不一致时以 sessionId 为准', () => {
  const state = normalizeState({ members: { 'session-key': { sessionId: 'session-value', alias: 'x' } } })
  assert.deepEqual(Object.keys(state.members), ['session-value'])
})

test('normalizeState：默认群始终同步为全部成员', () => {
  const state = normalizeState({
    members: { 'session-a': { sessionId: 'session-a' }, 'session-b': { sessionId: 'session-b' } },
    groups: { [DEFAULT_GROUP_ID]: { groupId: DEFAULT_GROUP_ID, name: '我的工作室', memberIds: ['bogus'] } },
  })
  assert.deepEqual(new Set(state.groups[DEFAULT_GROUP_ID].memberIds), new Set(['session-a', 'session-b']))
})

test('normalizeState：其它 group 原样保留（多群预留）', () => {
  const state = normalizeState({
    groups: { extra: { groupId: 'extra', name: '另一个群', memberIds: ['session-z'] } },
  })
  assert.equal(state.groups.extra.name, '另一个群')
  assert.deepEqual(state.groups.extra.memberIds, ['session-z'])
})

test('memberUpsert：新建 vs 更新，且不改原状态对象', () => {
  const base = emptyState()
  const created = memberUpsert(base, { sessionId: 'session-a', alias: '教练成员', color: 'blue' })
  assert.equal(created.created, true)
  assert.equal(created.member.locked, true)
  assert.deepEqual(Object.keys(base.members), [], '原状态不得被就地修改')

  const updated = memberUpsert(created.state, { sessionId: 'session-a', locked: false, caps: ['模板生成'] })
  assert.equal(updated.created, false)
  assert.equal(updated.member.locked, false, 'locked 可被显式解锁')
  assert.deepEqual(updated.member.caps, ['模板生成'])
  assert.equal(updated.member.alias, '教练成员', '未提供的字段保持不变')
  assert.equal(updated.member.color, 'blue')
})

test('memberUpsert：缺少 sessionId 抛错', () => {
  assert.throws(() => memberUpsert(emptyState(), {}), /需要 sessionId/)
})

test('memberUpsert：order 递增，成员追加在后面', () => {
  let state = emptyState()
  state = memberUpsert(state, { sessionId: 'session-a' }).state
  state = memberUpsert(state, { sessionId: 'session-b' }).state
  assert.equal(state.members['session-a'].order, 1)
  assert.equal(state.members['session-b'].order, 2)
  assert.equal(nextOrder(state), 3)
})

test('memberRemove：只删登记，缺失时是幂等的', () => {
  let state = memberUpsert(emptyState(), { sessionId: 'session-a' }).state
  const removed = memberRemove(state, 'session-a')
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.state.members, {})
  assert.deepEqual(removed.state.groups[DEFAULT_GROUP_ID].memberIds, [])
  assert.equal(memberRemove(removed.state, 'session-a').removed, false)
})

test('sortedMembers：置顶在前，其次按 order', () => {
  let state = emptyState()
  for (const id of ['session-a', 'session-b', 'session-c']) state = memberUpsert(state, { sessionId: id }).state
  state = memberUpsert(state, { sessionId: 'session-c', pinned: true }).state
  assert.deepEqual(
    sortedMembers(state).map((member) => member.sessionId),
    ['session-c', 'session-a', 'session-b'],
  )
})

test('isLocked：只对锁定成员为真', () => {
  let state = memberUpsert(emptyState(), { sessionId: 'session-a' }).state
  assert.equal(isLocked(state, 'session-a'), true)
  assert.equal(isLocked(state, 'session-missing'), false, '非成员永远不算锁定')
  state = memberUpsert(state, { sessionId: 'session-a', locked: false }).state
  assert.equal(isLocked(state, 'session-a'), false)
})

test('StudioStore：落盘 → 重新读取 → 状态一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-test-'))
  const file = path.join(dir, 'nested', 'studio.json')
  try {
    const store = new StudioStore(file)
    store.load()
    assert.equal(store.loadError, undefined, '文件不存在不应算错误')
    store.upsert({ sessionId: 'session-a', alias: '教练成员', color: 'violet', caps: ['模板生成'] })
    store.upsert({ sessionId: 'session-b', pinned: true })

    const reopened = new StudioStore(file)
    reopened.load()
    assert.equal(reopened.loadError, undefined)
    assert.equal(reopened.members().length, 2)
    const a = reopened.state.members['session-a']
    assert.equal(a.alias, '教练成员')
    assert.equal(a.color, 'violet')
    assert.equal(a.locked, true)
    assert.deepEqual(a.caps, ['模板生成'])
    assert.equal(reopened.state.members['session-b'].pinned, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('StudioStore：原子写不留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-test-'))
  const file = path.join(dir, 'studio.json')
  try {
    const store = new StudioStore(file)
    store.load()
    store.upsert({ sessionId: 'session-a' })
    store.upsert({ sessionId: 'session-b' })
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], '不应残留临时文件')
    assert.deepEqual(fs.readdirSync(dir), ['studio.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('StudioStore：文件损坏时降级为空状态并记录原因，而不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-test-'))
  const file = path.join(dir, 'studio.json')
  try {
    fs.writeFileSync(file, '{ this is not json', 'utf8')
    const store = new StudioStore(file)
    store.load()
    assert.deepEqual(store.members(), [])
    assert.equal(typeof store.loadError, 'string', '应记录读取失败原因供面板显示')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('StudioStore.mutate：落盘失败会抛出（调用方转成 RPC 错误）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-studio-test-'))
  try {
    // 让父路径是一个普通文件：mkdirSync 必然失败。
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf8')
    const store = new StudioStore(path.join(blocker, 'studio.json'))
    store.load()
    assert.throws(() => store.upsert({ sessionId: 'session-a' }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
