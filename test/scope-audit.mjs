// dsh-studio — 作用域守卫（回归测试）。**两类静默失败都要挡**。
//
// 事故一（样式表全灭）：把 `HIDDEN_ATTR` 定义在 `buildPlugin` 内部，而**模块级**的
//   `buildSidebarCss` 引用了它 → ReferenceError → 被装饰函数的 try/catch 吞掉 →
//   整张样式表写不进去，让位/灰底/彩点/置顶/隐藏**全部静默失效**（用户看到"功能回退了"）。
//
// 事故二（面板整个消失）：把 `activityBySession` 定义在 `apply()` 内部，而**面板组件**
//   （`MembersTab` / `ChatTab`，定义在 apply 之外）引用了它 → 渲染时 `activityBySession is not defined`
//   → 产品槽位把异常吞掉、只留一个空的 `data-slot-error` 容器 →
//   用户看到"工作室界面和呼出按钮都不见了"，且没有任何提示。
//
// 两次都是"名字在内层、用它的地方在外层"，两次都被 catch 吞掉。所以这里做两项静态检查：
//   A. 模块级函数引用的全大写常量，必须在模块作用域定义；
//   B. **`apply()` 内部声明的名字（常量与函数），不能被 `apply()` 之外的代码引用。**
//
//   node test/scope-audit.mjs

import fs from 'node:fs'

const source = fs.readFileSync(
  process.env.DSH_STUDIO_AUDIT_TARGET ?? new URL('../src/client.js', import.meta.url),
  'utf8',
)
const moduleConsts = new Set([...source.matchAll(/^ {2}const ([A-Z][A-Z0-9_]*) =/gm)].map((match) => match[1]))
const innerConsts = new Set([...source.matchAll(/^ {4,}const ([A-Z][A-Z0-9_]*) =/gm)].map((match) => match[1]))

const problems = []

// ── 检查 A ─────────────────────────────────────────────────────────────
// ⚠️ 只查 `${CONST}` 是不够的：第三次事故里，模块级函数是**直接**引用 `GROUP_LINE_RE.exec(...)`
//    （没有包在模板串里），照样 ReferenceError。所以这里把注释与字符串字面量剥掉，
//    再扫出**所有全大写标识符**，逐个核对是否在模块作用域定义过。
const JS_GLOBALS = new Set([
  'JSON', 'URL', 'NaN', 'Infinity', 'Math', 'Object', 'Number', 'String', 'Array', 'Map', 'Set', 'Date',
  'Promise', 'Error', 'RegExp', 'Boolean', 'Symbol', 'Intl', 'TextEncoder', 'TextDecoder', 'AbortController',
  'CSS', 'DOM', 'HTTP', 'OK', 'UTF', 'ID', 'QS', 'IP',
])

/** 剥掉注释与字符串字面量（避免把字符串里的词当标识符）。 */
function stripLiterals(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

for (const match of source.matchAll(/^ {2}function ([A-Za-z0-9_]+)\([^)]*\) \{\n([\s\S]*?)^ {2}\}/gm)) {
  const [, name, body] = match
  const bare = stripLiterals(body)
  // 本函数**自己声明**的常量不算问题（例如 buildPlugin 内部的 GROUP_LINE_RE）。
  const declaredHere = new Set([...bare.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/g)].map((hit) => hit[1]))
  const used = new Set([...bare.matchAll(/(?<![A-Za-z0-9_$.])([A-Z][A-Z0-9_]{2,})(?![A-Za-z0-9_$])/g)].map((hit) => hit[1]))
  const missing = [...used].filter(
    (constant) => !moduleConsts.has(constant) && !declaredHere.has(constant) && !JS_GLOBALS.has(constant),
  )
  if (missing.length > 0) problems.push({ kind: 'A', name, missing })
}

// ── 检查 B：apply() 内部声明 vs apply() 之外的使用 ───────────────────────
/** 按花括号配平，从 `start`（某个 `{` 的下标）取到匹配的 `}` 的下标。 */
function matchBrace(text, start) {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const applyMatch = /^ {4}function apply\(ctx\) \{\n/m.exec(source)
if (applyMatch === null) {
  problems.push({ kind: 'B', name: 'apply', missing: ['（找不到 apply(ctx)，检查脚本本身）'] })
} else {
  const bodyStart = applyMatch.index + applyMatch[0].length - 1 // 指向 `{`
  const bodyEnd = matchBrace(source, bodyStart)
  if (bodyEnd < 0) {
    problems.push({ kind: 'B', name: 'apply', missing: ['（apply 的花括号不配平）'] })
  } else {
    const applyBody = source.slice(bodyStart, bodyEnd + 1)
    // apply 内部声明的名字：`const x =` / `let x =` / `const x = (` / 函数声明
    const declaredInside = new Set()
    for (const hit of applyBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) declaredInside.add(hit[1])
    for (const hit of applyBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g)) declaredInside.add(hit[1])
    // 形参与解构不参与（它们本来就不该在外层用）
    for (const hit of applyBody.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of hit[1].split(',')) {
        const name = part.split(':').pop().trim()
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) declaredInside.add(name)
      }
    }
    // 只关心"名字"级别的可疑引用：在 apply 之外出现的、且看起来像内部状态的名字
    const outside = source.slice(0, bodyStart) + source.slice(bodyEnd + 1)
    const suspicious = []
    for (const name of declaredInside) {
      // 跳过极短/极通用的名字，避免误报（i、e、x 这类循环变量）
      if (name.length < 4) continue
      // 内部状态通常带这些特征后缀/前缀；只对"看起来像跨作用域状态"的名字报警
      if (!/(Attr|Key|Map|Timer|Store|Ref|Css|Width|Ms|MS|By|Of|State|Status|Count|Sent|Pending)$/.test(name)) continue
      const used = new RegExp(`(?<![A-Za-z0-9_$.])${name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`).test(outside)
      if (used) suspicious.push(name)
    }
    if (suspicious.length > 0) problems.push({ kind: 'B', name: 'apply', missing: suspicious })
  }
}

console.log(`模块作用域常量（${moduleConsts.size}）：${[...moduleConsts].join(', ')}`)
console.log(`函数内部常量（${innerConsts.size}）：${[...innerConsts].join(', ') || '（无）'}`)
if (problems.length === 0) {
  console.log('✓ 检查 A：模块级函数的常量引用都在模块作用域内')
  console.log('✓ 检查 B：apply() 内部声明的状态没有被 apply() 之外的代码引用')
  process.exit(0)
}
for (const problem of problems) {
  if (problem.kind === 'A') {
    console.log(`✗ [A] 模块级函数 ${problem.name} 引用了只在内层定义的常量：${problem.missing.join(', ')}`)
  } else {
    console.log(`✗ [B] apply() 内部声明的名字被 apply() 之外引用：${problem.missing.join(', ')}`)
  }
  console.log('  —— 这会在运行时抛 ReferenceError，而调用方通常把它吞掉，表现为"功能静默失效/界面消失"。')
  console.log('  —— 修法：把声明提到**模块作用域**（最外层），两边就都能看见。')
}
process.exit(1)
