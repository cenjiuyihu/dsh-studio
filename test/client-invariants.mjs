// dsh-studio — **不开浏览器**也能验的客户端不变量（成员「示例乙」提出：它 Playwright 打不开页面，
// 于是这三处改动它只能"无法确认"；它希望有能自查的路子，而不是每次求人）。
//
// 这个脚本只做**源码级/静态**判定，因此它不能证明"渲染出来是对的"，
// 但它能把"常量改了没有、机制还在不在、有没有退回到已知的错误做法"钉死。
// 每一条都写明「它证明了什么 / 它不能证明什么」——不给假的确认。
//
// 用法：node test/client-invariants.mjs
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
let failed = 0
const check = (name, ok, proves, notProves) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  console.log(`     证明：${proves}`)
  console.log(`     不证明：${notProves}`)
  if (!ok) failed += 1
}

// ── 改动一：时间线容量 800 ──────────────────────────────────────────────
const maxTimeline = /const MAX_TIMELINE = (\d+);/.exec(source)?.[1]
const storeChars = /const MAX_TIMELINE_STORE_CHARS = (\d+);/.exec(source)?.[1]
const version = /const TIMELINE_VERSION = (\d+);/.exec(source)?.[1]
check(
  `时间线容量 = 800（实际 ${maxTimeline}）+ 持久化版本 = 4（实际 ${version}）+ 存储上限 = ${storeChars} 字符`,
  maxTimeline === '800' && version === '4' && storeChars === '2000000',
  '源码里的容量常量与持久化版本号就是这三个值；旧版容量 200 的痕迹已不存在',
  '浏览器里实际存满 800 条后不丢 —— 那需要真实跑满，属运行时行为',
)
const trimBranch = source.includes('next.length > MAX_TIMELINE ? next.slice(next.length - MAX_TIMELINE) : next')
check(
  '截断分支存在（超限时保留**最后** 800 条，而不是丢新的）',
  trimBranch,
  '超限时的取舍方向是"丢最旧"，不会把新消息截掉',
  '不发生 off-by-one（例如实际保留 801 条）——需要真跑',
)

// ── 改动二：刷新后定位到最近未读 ────────────────────────────────────────
const usesRect = source.includes('node.getBoundingClientRect().top - el.getBoundingClientRect().top')
const usesOffsetTop = /el\.scrollTop = Math\.max\(0, node\.offsetTop/.test(source)
check(
  '未读定位用**视口矩形差**，且已不再用 `node.offsetTop - el.offsetTop`',
  usesRect && !usesOffsetTop,
  '定位算式与 offsetParent 无关（旧的 offsetTop 写法只在两个节点共享 offsetParent 时才成立）',
  '滚动落点在人眼看来"正好在第一条未读"——像素级结果只能目测',
)
const firstUnreadLogic = source.includes('merged.find((message) => String(message.at) > String(mark))')
check(
  '"第一条未读 = 时间严格晚于已读标记的第一条"这条判据还在',
  firstUnreadLogic,
  '未读的**定义**没变（严格大于，不是大于等于）',
  '读标记何时被更新（贴底/点按钮）——那是交互路径',
)
const markOnMissing = /positionTryRef\.current <= 3/.test(source)
check(
  '"第一条未读还没渲染出来"时不再立刻把全部标成已读（改为重试 ≤3 次）',
  markOnMissing,
  '旧版会在找不到 DOM 节点时直接 `markRead` 把未读清零（=未读静默消失），该路径已被换掉',
  '重试 3 次后仍找不到时的兜底表现好不好 —— 需要构造时序',
)

// ── 改动三：轨迹视图的群聊泄露已堵 ───────────────────────────────────────
const trajectoryHiding = source.includes('data-turn-start') && source.includes('data-turn-end')
check(
  '轨迹视图按 `data-turn-start` / `data-turn-end` 划回合边界并整段隐藏',
  trajectoryHiding,
  '轨迹视图那套隐藏机制还在（这正是当初泄露的入口：只处理了对话视图，切到轨迹就露）',
  '实际隐藏了多少行 —— 必须真在带群聊回合的会话里数',
)
const hiddenCss = source.includes('`[${HIDDEN_ATTR}]{display:none!important;}`')
check(
  '隐藏属性有对应 CSS（`display:none!important`）',
  hiddenCss,
  '加了属性就真的会被藏起来（曾经因为样式表整张写不进去而静默失效）',
  '样式表被成功注入 —— 那要看 `window.__DSH_STUDIO__.styleTagLength() > 0`',
)

// ── 一条"防回归"：群聊前缀解析仍在（客户端自带一份） ──────────────────────
const groupRe = /【群聊·\(\[\^｜\]\*\)/.test(source)
check('客户端自带群聊前缀解析正则（bundle 不能 import 服务端模块，两边各一份）', groupRe, '客户端仍能识别群聊消息', '两端口径一致 —— 这靠人维护，改一处要改两处')

console.log(
  failed === 0
    ? '\n静态不变量全部通过。**但请注意**：它证明的是"机制/常量还在且没退回已知错误做法"，不等于"渲染效果正确"。\n'
    : `\n${failed} 项不通过 —— 至少有一处改动被回退或写错了。\n`,
)
process.exit(failed === 0 ? 0 : 1)
