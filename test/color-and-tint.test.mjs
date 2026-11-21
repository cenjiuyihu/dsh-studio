// dsh-studio — 颜色解析与「当前会话底色染色」的**行为**测试（不是静态不变量）。
//
// 为什么不能像别的模块那样直接 import 来测（2026-11-21 读码确认）：
//   `src/client.js` 是 **classic script**（首行注释写明"不 import、不构建，通过
//   window.__ModuleLoader__.load 注册"），所有辅助函数都在闭包里，对外不可达。
//   所以这里的做法是：**读真实源码文本 → 按声明位置抽出函数体 → 在 vm 外的普通函数里求值**。
//   它测的是**仓库里正在跑的那段代码**，不是复制品。
//
// 代价与纪律（必须写在文件里，否则下一个人会误信）：
//   · 抽取靠"缩进 + 同行收尾花括号"这条文本规则 ⇒ 源码排版大改会**抽取失败**（测试红）。
//     这是刻意的：宁可红，也不要静默抽到别的东西还宣布通过。
//   · 因此本文件第 3 节有一条**抽取器的阴性对照**：喂一个不存在的函数名，必须返回 null。
//   · 它证明"这几个纯函数算得对"；不证明"浏览器里染色看起来对"（那要人眼看）。
//
// 用法：node test/color-and-tint.test.mjs
// 退出码：0 = 全过；1 = 有失败

import fs from 'node:fs'

const SOURCE = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const LINES = SOURCE.split(/\r?\n/)

let failed = 0
let passed = 0
const check = (label, ok, note) => {
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? '✅' : '❌'} ${label}`)
  if (note !== undefined) console.log(`     ${note}`)
}

// ── 抽取器 ────────────────────────────────────────────────────────────────
/** 取从含 startNeedle 的行到含 endNeedle 的行（含两端，整行）。抽不到返回 null。 */
function statements(startNeedle, endNeedle) {
  const from = LINES.findIndex((line) => line.includes(startNeedle))
  if (from < 0) return null
  const to = LINES.findIndex((line, index) => index >= from && line.includes(endNeedle))
  if (to < 0) return null
  return LINES.slice(from, to + 1).join('\n')
}

/**
 * 抽一个 `function name(...)` 的完整源码。
 * 判据：从声明行开始，遇到**缩进与声明相同、内容仅为 `}`** 的行即为结束。
 * 同时校验大括号配平（模板字面量里的 `${...}` 也是配平的，所以这个计数成立）。
 */
function functionSource(name) {
  const declaration = `function ${name}(`
  const start = LINES.findIndex((line) => line.trimStart().startsWith(declaration))
  if (start < 0) return null
  const indent = /^\s*/.exec(LINES[start])[0]
  let end = -1
  for (let index = start; index < LINES.length; index += 1) {
    if (index === start) continue
    if (LINES[index] === `${indent}}`) {
      end = index
      break
    }
  }
  if (end < 0) return null
  const body = LINES.slice(start, end + 1).join('\n')
  let depth = 0
  for (const char of body) {
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth < 0) return null
  }
  if (depth !== 0) return null
  if (!body.trimEnd().endsWith('}')) return null
  return body
}

// ── 1. 抽取器自身的阴性对照（必须先过，否则后面全部结论无意义）──────────────
console.log('\n=== 1) 抽取器阴性对照 ===')
check('不存在的函数名 → 抽取返回 null', functionSource('noSuchHelperExists') === null, '抽取器不是"总能捞到点什么"')
check(
  '存在的函数名 → 抽取结果以 `function <name>(` 开头且以 `}` 收尾',
  (() => {
    const source = functionSource('rgbTriplet')
    return typeof source === 'string' && source.trimStart().startsWith('function rgbTriplet(') && source.trimEnd().endsWith('}')
  })(),
  '抽到的是片段本身，不是"从某处到文件末尾"',
)

// ── 2. 组装被测代码（用真实源码文本求值）──────────────────────────────────
const paletteBlock = statements('const PALETTE = [', 'const HEX_RE =')
const cBlock = statements('const C = {', '};')
const pieces = {
  resolveMemberColor: functionSource('resolveMemberColor'),
  rgbTriplet: functionSource('rgbTriplet'),
  tintRgba: functionSource('tintRgba'),
  inheritOf: functionSource('inheritOf'),
  inheritTierColor: functionSource('inheritTierColor'),
}
const missing = [paletteBlock === null ? 'PALETTE 块' : null, cBlock === null ? 'C 块' : null]
  .concat(Object.entries(pieces).filter(([, value]) => value === null).map(([key]) => key))
  .filter((value) => value !== null)

console.log('\n=== 2) 源码抽取 ===')
check(
  `抽出 PALETTE/COLOR_OF/HEX_RE + C + 5 个函数（缺失：${missing.length === 0 ? '无' : missing.join('、')}）`,
  missing.length === 0,
  '源码排版若大改，这里会红 —— 这是刻意的，不是脆弱',
)
if (missing.length > 0) {
  console.log('\n抽取失败，后续断言无法进行。')
  process.exit(1)
}

// 纯函数不该摸 DOM：抽出来的文本里出现这些就等于"它其实不是纯的"，测试也就不再自足。
const impure = Object.entries(pieces).filter(([, source]) =>
  /\b(document|window|localStorage|sessionStorage)\./.test(source),
)
check(
  '抽出的 5 个函数都不引用 document/window/localStorage',
  impure.length === 0,
  impure.length === 0 ? '它们确实是纯函数，可以脱离浏览器断言' : `非纯：${impure.map(([name]) => name).join('、')}`,
)

const api = new Function(
  `${paletteBlock}\n${cBlock}\n${Object.values(pieces).join('\n')}\n` +
    'return { PALETTE, COLOR_OF, HEX_RE, C, resolveMemberColor, rgbTriplet, tintRgba, inheritOf, inheritTierColor };',
)()
const { PALETTE, COLOR_OF, C, resolveMemberColor, rgbTriplet, tintRgba, inheritOf, inheritTierColor } = api

// ── 3. 色板（历史 key 不可改名，否则所有成员静默换色）─────────────────────
console.log('\n=== 3) 色板 ===')
const LEGACY_KEYS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet', 'cyan', 'orange']
check(`PALETTE 共 16 色（实际 ${PALETTE.length}）`, PALETTE.length === 16, '扩色那次的容量没被改回去')
check(
  '前 8 个 key 与历史值完全一致（' + LEGACY_KEYS.join('/') + '）',
  LEGACY_KEYS.every((key, index) => PALETTE[index]?.key === key),
  '成员记录里存的是 key，改名 = 所有成员静默变回兜底色',
)
const keys = PALETTE.map((entry) => entry.key)
const colors = PALETTE.map((entry) => entry.color)
check('key 无重复', new Set(keys).size === keys.length, `实际 ${new Set(keys).size} 个唯一 key`)
check('色值无重复', new Set(colors).size === colors.length, `实际 ${new Set(colors).size} 个唯一色`)
check(
  '每个色值都是 6 位 #rrggbb 小写十六进制',
  colors.every((color) => /^#[0-9a-f]{6}$/.test(color)),
  '色板里若混进 3/4/8 位写法，染色会静默失效（见第 5 节的已知不一致）',
)
check('COLOR_OF 与 PALETTE 一一对应', keys.every((key) => COLOR_OF[key] === PALETTE.find((entry) => entry.key === key).color))

// ── 4. resolveMemberColor：唯一入口，未知一律回落 ─────────────────────────
console.log('\n=== 4) resolveMemberColor ===')
const FALLBACK = PALETTE[0].color
const resolveCases = [
  ['blue', '#4c8dff', 'key → 色值'],
  ['  sky  ', '#38bdf8', '两端空白被 trim'],
  ['#A1B2C3', '#A1B2C3', '自定义色原样返回（保留大小写）'],
  ['#0af', '#0af', '3 位简写也接受'],
  ['nope', FALLBACK, '未知 key → 兜底色'],
  ['red', FALLBACK, 'CSS 关键字**不**接受（只认 key 与 #hex）'],
  ['', FALLBACK, '空串 → 兜底色'],
]
for (const [input, expected, label] of resolveCases) {
  const actual = resolveMemberColor(input)
  check(`${JSON.stringify(input)} → ${expected}（${label}）`, actual === expected, actual === expected ? undefined : `实际 ${JSON.stringify(actual)}`)
}
for (const input of [undefined, null, 42, {}, []]) {
  check(`非字符串 ${Object.prototype.toString.call(input)} → 兜底色`, resolveMemberColor(input) === FALLBACK)
}
// 安全：这个值会进 CSS，注入形态必须过不去
const INJECTION = '#fff; } body { display: none } .x {'
check(
  'CSS 注入形态被拒绝（不会原样返回）',
  resolveMemberColor(INJECTION) === FALLBACK && resolveMemberColor(INJECTION) !== INJECTION,
  'HEX_RE 是 ^…$ 锚定的，染色值不能从颜色字段跑出去改别的样式',
)

// ── 5. rgbTriplet / tintRgba ─────────────────────────────────────────────
console.log('\n=== 5) rgbTriplet ===')
const tripletCases = [
  ['#0af', '0, 170, 255', '3 位展开'],
  ['#4c8dff', '76, 141, 255', '6 位'],
  ['#FFF', '255, 255, 255', '大写也接受'],
  ['0af', '0, 170, 255', '没写 # 也接受（前缀被剥掉）'],
]
for (const [input, expected, label] of tripletCases) {
  check(`rgbTriplet(${JSON.stringify(input)}) → "${expected}"（${label}）`, rgbTriplet(input) === expected, undefined)
}
for (const input of ['zzz', '', '#12', '#12345', null, undefined, '#gggggg']) {
  check(`rgbTriplet(${JSON.stringify(input)}) → null`, rgbTriplet(input) === null)
}

// 染色前提：色板里**每一个**颜色都必须能被解析成三元组。
check(
  '16 色全部能被 rgbTriplet 解析',
  PALETTE.every((entry) => rgbTriplet(entry.color) !== null),
  '以后往色板加颜色，若格式写错这里立刻红 —— 否则就是"侧栏有色、底色不染"的静默不一致',
)

console.log('\n=== 6) tintRgba ===')
const tintCases = [
  ['#e5534b', 0.14, 'rgba(229, 83, 75, 0.14)'],
  ['#4c8dff', 0.22, 'rgba(76, 141, 255, 0.22)'],
  ['#8a8f98', 0.1, 'rgba(138, 143, 152, 0.1)'],
  ['#8a8f98', 0.123456, 'rgba(138, 143, 152, 0.123)'],
]
for (const [hex, alpha, expected] of tintCases) {
  check(`tintRgba(${hex}, ${alpha}) → "${expected}"`, tintRgba(hex, alpha) === expected, undefined)
}
check('非法颜色 → "transparent"（不抛错、不写半个 rgba）', tintRgba('nope', 0.14) === 'transparent')
check(
  '色板全部 16 色都能生成合法 rgba 串（不是 transparent）',
  PALETTE.every((entry) => /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.\d+\)$/.test(tintRgba(entry.color, 0.14))),
  '染色时不会有一半成员"看起来没染"',
)
// ⚠️ 已知不一致（**不是**期望行为，也没修）：HEX_RE 允许 4/8 位，#4 位能存成成员色、
//    但 rgbTriplet 只认 3/6 位 ⇒ 侧栏色标正常、底色染色静默失效（回落 transparent）。
//    取色器目前只产出 6 位，所以线上没被触发过。这条断言是**把现状钉住**，不是背书。
check(
  '【已知不一致】4/8 位自定义色：能存（HEX_RE 过），但染不上色（rgbTriplet 为 null）',
  resolveMemberColor('#abcd') === '#abcd' && rgbTriplet('#abcd') === null,
  '现状如此。若要修，须先定语义（8 位是否忽略 alpha），别在发布提交里顺手改行为',
)

// ── 7. 继承相关的两个纯函数（面板徽标用）────────────────────────────────
console.log('\n=== 7) inheritOf / inheritTierColor ===')
check('inheritOf(undefined, …) → undefined（不抛）', inheritOf(undefined, 'a') === undefined)
check('inheritOf(null, …) → undefined（不抛）', inheritOf(null, 'a') === undefined)
check('members 不是数组时 → undefined（容错）', inheritOf({ members: 'nope' }, 'a') === undefined)
const found = inheritOf({ members: [{ sessionId: 'a' }, { sessionId: 'b' }] }, 'b')
check('正常命中返回该条记录', found !== undefined && found.sessionId === 'b')
check('找不到 → undefined', inheritOf({ members: [{ sessionId: 'a' }] }, 'zzz') === undefined)
const tierCases = [
  ['silent', C.label3],
  ['warn', C.warn],
  ['strong', C.warn],
  ['schedule', C.error],
]
for (const [tier, expected] of tierCases) {
  check(`inheritTierColor(${JSON.stringify(tier)}) → ${expected}`, inheritTierColor(tier) === expected)
}
check('未知档位 → 最弱的那一档（不抢眼）', inheritTierColor('nonsense') === C.label3)
check(
  'schedule 与 warn/strong 用不同颜色（不能把"该交接了"和"快该交接了"画成一个样子）',
  inheritTierColor('schedule') !== inheritTierColor('warn'),
)

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
console.log('它证明：上述纯函数对给定输入的返回值；色板/历史 key/档位配色没有被静默改动。')
console.log('它不证明：浏览器里染色实际长什么样、强度 14 是否合适 —— 那只能人眼在页面上看。')
process.exit(failed === 0 ? 0 : 1)
