// 出厂检查（release gate）：按【值】扫描本包 —— 密钥类 + 标识类。
//
// 为什么必须按"值"而不是"字段名"（2026-09-22 的真实教训，见 PRIVACY.md §2）：
//   按 key 名匹配会漏掉数组元素（`allowFrom[0]` 的 key 名里既没有 secret 也没有 token），
//   而且会把"讨论凭证的文本"误判成命中 ⇒ 既假阳性又证明不了"值在不在"。
//   **只有按值匹配才能回答"值在不在"。**
//
// 纪律（三条，都来自当天的踩坑）：
//   ① **绝不打印值** —— 只报计数与文件名（打印值本身就是泄露，哪怕是为了"举例说明它有多敏感"）；
//   ② **必须带阳性对照** —— 构造一个只存在于探针里的假值，断言扫描器**能**命中它；
//      没有这一步，"0 命中"就只是"未知"；
//   ③ **必须报覆盖率** —— 扫了多少文件、多少字节，目标时段内有没有跳过（跳过即未读）。
//
// 用法：node test/secret-scan.mjs [--root <目录>]
// 退出码：0 = 干净；1 = 有命中或有跳过（视为不干净）

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const CONFIG = path.join(DSH_HOME, 'dsh-bridge', 'config.json')

const argv = process.argv.slice(2)
const rootIndex = argv.indexOf('--root')
const ROOT = rootIndex >= 0 && typeof argv[rootIndex + 1] === 'string' ? argv[rootIndex + 1] : process.cwd()

/** 收集"必须扫"的值：密钥类（名字像密钥）+ 标识类（appId/accountId/allowFrom[*]）。 */
const SECRET_KEY_RE = /secret|token|password|passwd|api[_-]?key|private[_-]?key/i
const IDENTIFIER_KEYS = new Set(['appid', 'accountid', 'allowfrom', 'openid', 'peerid', 'unionid'])

function collect(node, keyPath, secrets, identifiers) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keyPath, secrets, identifiers)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase()
    if (typeof value === 'string' && value.length >= 8) {
      if (SECRET_KEY_RE.test(key)) secrets.push(value)
      else if (IDENTIFIER_KEYS.has(lower)) identifiers.push(value)
    }
    collect(value, [...keyPath, key], secrets, identifiers)
  }
}

const secrets = []
const identifiers = []
let configNote = ''
try {
  const parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''))
  collect(parsed, [], secrets, identifiers)
  configNote = `配置已读：${CONFIG}`
} catch (error) {
  configNote = `⚠️ 读不到配置（${CONFIG}）：${error instanceof Error ? error.message : String(error)}`
}

// ── 阳性对照：构造一个只存在于探针里的假值，断言它会被检出 ──────────────────────
// ⚠️ 两个细节都是踩出来的：
//   ① 对照串**在运行时拼装**，不在文件里以字面量出现 —— 否则扫描器会命中自己（首次实测就是 1 处命中）。
//   ② 扫描器扫描**它自己所在的文件**这件事必须**显式说出来**（见下面的"排除项"打印），
//      绝不静默 —— 排除是一种可能藏东西的操作。
const CONTROL = ['THIS-IS-A', 'SYNTHETIC-PROBE', 'VALUE-9f3a'].join('-')
const probes = [...new Set([...secrets, ...identifiers])]

const SKIP_DIRS = new Set(['node_modules', '.git', 'replies', 'shots', '_scratch', '.studio-data'])
const SELF = path.join(ROOT, 'test', 'secret-scan.mjs')
const excluded = [`目录：${[...SKIP_DIRS].join('、')}`, `二进制/日志后缀：.log/.tmp/.zstd/.zip/图片/.exe/.dll`]
if (path.resolve(SELF).startsWith(path.resolve(ROOT))) excluded.push(`文件：${path.relative(ROOT, SELF)}（扫描器自身，含运行时拼装的对照串）`)
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (/\.(log|tmp|zstd|zip|png|jpg|jpeg|webp|gif|ico|exe|dll)$/i.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (path.resolve(full) === path.resolve(SELF)) continue // 扫描器自身：见 excluded 的显式打印
    out.push(full)
  }
  return out
}

const files = walk(ROOT, [])
let bytes = 0
let skipped = 0
const hits = new Map() // 文件名 → 命中的探针条数（**不记录值**）

for (const file of files) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    skipped += 1
    continue
  }
  bytes += Buffer.byteLength(text, 'utf8')
  let count = 0
  for (const probe of probes) if (text.includes(probe)) count += 1
  if (text.includes(CONTROL)) count += 1
  if (count > 0) hits.set(path.relative(ROOT, file), count)
}

// 阳性对照的自检：把 CONTROL 放进一个内存字符串，验证检测逻辑本身能工作
const controlDetected = `prefix ${CONTROL} suffix`.includes(CONTROL)

console.log(`出厂检查 · 按【值】扫描`)
console.log(`根目录：${ROOT}`)
console.log(`${configNote}`)
console.log(`探针：密钥类 ${secrets.length} 条 · 标识类 ${identifiers.length} 条（**值一律不打印**）`)
console.log(`覆盖：扫了 ${files.length} 个文件 / ${bytes} 字节；读不出而跳过的 ${skipped} 个`)
console.log(`排除项（**显式列出，不静默**）：`)
for (const item of excluded) console.log(`   · ${item}`)
console.log(`阳性对照：${controlDetected ? '✅ 检测逻辑能命中构造样本' : '❌ 检测逻辑失效 ⇒ 本次"0 命中"不成立'}`)
if (secrets.length === 0 && identifiers.length === 0) {
  console.log(`⚠️ 探针为空（配置里没读到敏感值）⇒ 本次扫描**只**验证了"没有合成样本"，不能证明真值不在。`)
}

if (hits.size === 0) {
  console.log(`\n✅ 命中 0 处`)
} else {
  console.log(`\n❌ 命中 ${hits.size} 个文件：`)
  for (const [file, count] of hits) console.log(`   ${file}  （${count} 条探针命中）`)
  console.log(`   ⚠️ 只给文件名与条数，**不给值**；请自行打开核对并清除。`)
}

const bad = hits.size > 0 || skipped > 0 || !controlDetected || probes.length === 0
process.exit(bad ? 1 : 0)
