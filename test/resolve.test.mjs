// 寻址解析的回归测试：交接后新旧同名（`维护者` / `旧[日期]维护者`）不得误投。
//
// 为什么必须有正对照：这次改动要防的是"模糊查询落到已退役记录"。若测试只断言
// "`维护` → 新记录"，那**旧实现也可能碰巧通过**（取决于成员表顺序）⇒ 用例是空的。
// 所以下面照抄了一份旧实现（legacyFindMember），先证明它**确实**会投错，再证明新实现不投错。
import { findMember, findMemberCandidates, isRetired, labelOf } from '../src/protocol.js'

let pass = 0
const fails = []

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fails.push(`${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const NEW_ID = 'session-11111111-1111-4111-8111-111111111111'
const OLD_ID = 'session-22222222-2222-4222-8222-222222222222'
const NEW = { sessionId: NEW_ID, alias: '维护者', locked: true }
const OLD = { sessionId: OLD_ID, alias: '旧[2026-10-08]维护者', locked: false }
const COACH = { sessionId: 'session-33333333-3333-4333-8333-333333333333', alias: '示例甲', locked: true }

/** 2026-10-08 之前的实现原样照抄（用于正对照）。 */
function legacyFindMember(members, query) {
  const wanted = String(query ?? '').trim()
  if (wanted.length === 0) return undefined
  const lower = wanted.toLowerCase()
  const short = (id) => String(id).slice(8, 16)
  return (
    members.find((m) => m.alias.toLowerCase() === lower) ??
    members.find((m) => m.sessionId === wanted) ??
    members.find((m) => short(m.sessionId) === lower) ??
    members.find((m) => m.alias.toLowerCase().includes(lower))
  )
}

const name = (m) => (m === undefined ? undefined : labelOf(m))

console.log('\n【正对照】先证明旧实现真的会投错 —— 否则本用例无意义')
console.log(`  成员表顺序：${[OLD, NEW].map((m) => labelOf(m)).join(' → ')}（旧记录在前，即交接后的常见顺序）`)
// ⚠️ 第一版断言写成"任何顺序下旧实现都投错"，跑出来**是错的**：旧实现取"第一个子串命中"，
//    所以它是否投错**完全取决于成员表顺序** ⇒ 真实缺陷是"依赖顺序"，不是"永远错"。
//    断言按事实改成两条：旧在前＝误投；新在前＝碰巧对（⇒ 不可依赖）。
check('旧在前：旧实现「维护」误投到已退役记录', name(legacyFindMember([OLD, NEW], '维护')), '旧[2026-10-08]维护者')
check('新在前：旧实现「维护」碰巧命中新记录（⇒ 旧实现是顺序敏感的）', name(legacyFindMember([NEW, OLD], '维护')), '维护者')
check('新实现「维护」在「旧在前」顺序下命中新记录', name(findMember([OLD, NEW], '维护')), '维护者')
check('新实现「维护」在「新在前」顺序下同样命中新记录（顺序无关）', name(findMember([NEW, OLD], '维护')), '维护者')


console.log('\n【精确命中】新旧同名时，全名必须点到新记录')
check('精确别名「维护者」→ 新记录', name(findMember([OLD, NEW], '维护者')), '维护者')
check('精确别名「维护者」在反序成员表里也一样', name(findMember([NEW, OLD], '维护者')), '维护者')
check('完整会话 id → 旧记录', name(findMember([OLD, NEW], OLD_ID)), '旧[2026-10-08]维护者')
check('短 id「22222222」→ 旧记录', name(findMember([OLD, NEW], '22222222')), '旧[2026-10-08]维护者')
check('退役记录的**全名**仍可精确命中（精确不受退役降级影响）', name(findMember([OLD, NEW], '旧[2026-10-08]维护者')), '旧[2026-10-08]维护者')

console.log('\n【退役判据】别名前缀与 locked=false 两条都算退役')
check('别名带「旧[」⇒ 退役', isRetired(OLD), true)
check('别名带「旧·」⇒ 退役', isRetired({ sessionId: 'x', alias: '旧·某会话', locked: true }), true)
check('locked=false ⇒ 退役（哪怕别名没有前缀）', isRetired({ sessionId: 'x', alias: '某会话', locked: false }), true)
check('普通活跃成员 ⇒ 不是退役', isRetired(NEW), false)
check('名为「旧金山小组」但无分隔符 ⇒ 不是退役（不误伤）', isRetired({ sessionId: 'x', alias: '旧金山小组', locked: true }), false)

console.log('\n【歧义不猜】两位**活跃**成员共享子串时必须报歧义，而不是取第一个')
const A = { sessionId: 'session-aaaaaaaa-1111-2222-3333-444455556666', alias: '前端甲', locked: true }
const B = { sessionId: 'session-bbbbbbbb-1111-2222-3333-444455556666', alias: '前端乙', locked: true }
check('歧义查询 → findMember 返回 undefined（不猜）', name(findMember([A, B], '前端')), undefined)
check('歧义查询 → 候选列表两条', findMemberCandidates([A, B], '前端').map(labelOf), ['前端甲', '前端乙'])
check('前缀更精确时无歧义：命中「前端甲」', name(findMember([A, B], '前端甲')), '前端甲')
check('退役记录与活跃记录同子串 ⇒ 不算歧义，命中活跃的', findMemberCandidates([OLD, NEW], '维护').map(labelOf), ['维护者'])

console.log('\n【旧写法兼容】交接前的 `维护者(旧)` 仍要能点到那条退役记录')
check('「维护者(旧)」→ 退役记录（而不是新记录）', name(findMember([OLD, NEW], '维护者(旧)')), '旧[2026-10-08]维护者')
check('全角括号「维护者（旧）」→ 退役记录', name(findMember([OLD, NEW], '维护者（旧）')), '旧[2026-10-08]维护者')
check('「维护者(旧)」在反序成员表里同样命中退役记录', name(findMember([NEW, OLD], '维护者(旧)')), '旧[2026-10-08]维护者')
check('没有任何退役记录时，带 (旧) 的查询 → undefined', name(findMember([NEW, COACH], '维护者(旧)')), undefined)
check('带 (旧) 的查询不会漏到活跃记录上', name(findMember([NEW, COACH], '示例甲(旧)')), undefined)

console.log('\n【不匹配与空输入】')
check('完全不存在 → undefined', name(findMember([COACH, NEW], '不存在的名字')), undefined)
check('空查询 → undefined', name(findMember([COACH, NEW], '   ')), undefined)
check('空查询 → 无候选', findMemberCandidates([COACH, NEW], ''), [])
check('大小写不敏感（demo / DEMO）', name(findMember([{ sessionId: 'session-44444444-4444-4444-8444-444444444444', alias: 'demo', locked: true }], 'DEMO')), 'demo')

console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`)
if (fails.length > 0) {
  console.log('\n失败明细：')
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
