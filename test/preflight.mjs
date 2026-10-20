// 重启前自检（preflight）：确认 composition 里的 dsh-studio 各行都能真的加载，
// 避免"重启之后主星起不来"这种最贵的失败。
//
// 用法：node test/preflight.mjs
//
// 检查项：
//   1. cordis.patch.yml 里 dsh-studio BEGIN/END 段的每一行，子路径都能被 Node 解析；
//   2. 每个模块能 import 成功（加载期不抛错），且导出的 name 与配置里的 name 一致、apply 是函数；
//   3. 客户端 bundle 能被宿主取到（HTTP 200、非空）；
//   4. 数据文件 $DSH_HOME/studio/studio.json 能被本项目自己的 Store 解析。
//
// 为什么需要它：宿主条目**一旦加载就不再重新 import**，而失败发生在重启那一刻 ——
// 那时候用户已经付出了一次重启的代价。这个脚本把"能不能加载"提前到重启之前问一遍。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { StudioStore } from '../src/store.js'
import { resolveStoreFile } from '../src/protocol.js'

// ★ 不写死用户目录（公开版必须可移植，且本机绝对路径属于隐私）
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web')
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')
const WEB_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const require = createRequire(path.join(PROFILE_DIR, 'node_modules', 'x.js'))

let failures = 0
const ok = (label, detail) => console.log(`✅ ${label}${detail !== undefined ? `  ${detail}` : ''}`)
const bad = (label, detail) => {
  failures += 1
  console.log(`❌ ${label}${detail !== undefined ? `  ${detail}` : ''}`)
}

// ── 1. 解析 composition 里 dsh-studio 的行 ──────────────────────────────
console.log(`\n=== 1) composition 行（${PATCH_FILE}）===`)
let rows = []
try {
  const text = fs.readFileSync(PATCH_FILE, 'utf8')
  const begin = text.indexOf('dsh-studio BEGIN')
  const end = text.indexOf('dsh-studio END')
  if (begin < 0 || end < 0) throw new Error('找不到 dsh-studio BEGIN/END 标记')
  const block = text.slice(begin, end)
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[index])
    if (idMatch === null) continue
    const nameMatch = /^\s*name:\s*(\S+)\s*$/.exec(lines[index + 1] ?? '')
    rows.push({ id: idMatch[1], name: nameMatch !== null ? nameMatch[1] : undefined })
  }
  if (rows.length === 0) throw new Error('段内没有解析出任何行')
  for (const row of rows) {
    if (row.name === undefined) bad(`行 ${row.id} 缺少 name`)
    else ok(`行 ${row.id} → ${row.name}`)
  }
} catch (error) {
  bad('解析 composition 失败', error instanceof Error ? error.message : String(error))
}

// ── 2. 每行都能解析 + 加载 + name/apply 正确 ───────────────────────────
console.log('\n=== 2) 模块加载自检（模拟宿主 import）===')
for (const row of rows) {
  if (row.name === undefined) continue
  let resolved
  try {
    resolved = require.resolve(row.name)
  } catch (error) {
    bad(`${row.name} 无法解析`, error instanceof Error ? error.code ?? error.message : String(error))
    continue
  }
  try {
    const module = await import(row.name)
    if (module.name !== row.name) bad(`${row.name} 导出的 name 不一致`, `实际 ${String(module.name)}`)
    else if (typeof module.apply !== 'function') bad(`${row.name} 没有导出 apply 函数`)
    else ok(`${row.name} 可加载`, `name/apply 正常 · ${path.basename(resolved)}`)
  } catch (error) {
    bad(`${row.name} 加载期抛错`, error instanceof Error ? `${error.message}` : String(error))
  }
}

// ── 3. 客户端 bundle 取得到吗 ──────────────────────────────────────────
console.log('\n=== 3) 客户端 bundle ===')
try {
  const response = await fetch(`${WEB_URL}/plugins/dsh-studio/client.js`)
  const body = await response.text()
  if (response.status !== 200) bad('bundle 状态码异常', String(response.status))
  else if (body.length < 1000) bad('bundle 内容过短，可能是错误页', `${body.length} 字符`)
  else ok('bundle 可取', `HTTP 200 · ${body.length} 字符`)
} catch (error) {
  bad('bundle 取不到（宿主还没起来？）', error instanceof Error ? error.message : String(error))
}

// ── 4. 数据文件 ────────────────────────────────────────────────────────
console.log('\n=== 4) 数据文件 ===')
try {
  const storeFile = resolveStoreFile()
  const store = new StudioStore(storeFile)
  const state = store.load()
  const members = store.members()
  ok('成员表可解析', `${members.length} 位成员 · ${storeFile}`)
  const groups = Object.keys(state.groups ?? {})
  ok('群可解析', `${groups.length} 个群（active=${state.activeGroupId}）`)
} catch (error) {
  bad('数据文件解析失败', error instanceof Error ? error.message : String(error))
}

// ── 4b. **挂载自检**（一次真实故障后新增：这是最关键的一道闸）────────────
// 事故复盘：`src/tools.js` 里一个参数写了 `required: false` → `defineTool()` 编译期抛
// `JsonSchemaError` → 异常冒泡出 `apply()` → **整棵插件树挂载失败 → 主星启动 2 秒内退出**，
// 监督者重启 11 次全部撞同一堵墙（它无法改代码），停摆 15 分钟。
//
// 而当时的预检**只做了"模块能不能 import"**，给出的是**假绿灯** —— 与复盘报告里
// 「`--dump-config` 只做解析级校验」是同一类错误：**校验层级低于故障层级**。
// 现在补上真正的挂载层检查：拿桩 ctx 跑一遍 `apply()`，让 `defineTool()` 真的去编译 schema。
console.log('\n=== 4b) 挂载自检（真跑 apply，让 schema 真的被编译）===')
const STUB_CTX = () => {
  const registered = []
  const ctx = {
    registered,
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    agents: { get: () => undefined, resume: async () => ({ agent: { id: 'stub', sessionId: 'stub' } }) },
    webServer: { route: () => {}, get: () => {}, use: () => {} },
    slots: undefined,
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return ctx
}
for (const row of rows) {
  if (row.name === undefined) continue
  try {
    const module = await import(row.name)
    if (typeof module.apply !== 'function') continue
    const ctx = STUB_CTX()
    const result = module.apply(ctx)
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') await result
    const names = ctx.registered.map((tool) => (tool !== null && typeof tool === 'object' && tool.name !== undefined ? tool.name : '(无名)'))
    ok(`${row.name} 挂载成功`, names.length > 0 ? `注册工具：${names.join(', ')}` : '（无用工具注册，正常）')
  } catch (error) {
    bad(
      `${row.name} **挂载失败**（这正是"主星启动即崩"的那种方式）`,
      error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
    )
  }
}

// ── 4c. schema DSL 红线：`required` 一旦出现必须是 true；可选参数=不写这个键 ─────
try {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  let threw = false
  try {
    defineTool({
      name: 'preflight_probe',
      description: 'probe',
      parameters: { type: 'object', properties: { x: { type: 'string', required: false } }, additionalProperties: false },
      async execute() { return {} },
    })
  } catch {
    threw = true
  }
  if (threw) ok('schema 红线可被检出', 'required:false 会让 defineTool 抛错 —— 本项证明这道闸有效')
  else bad('schema 红线探针失效', 'required:false 竟然编译通过，说明本项检查无效，需重写')
} catch (error) {
  bad('无法加载 @deepseek-ai/dsh-tools', error instanceof Error ? error.message : String(error))
}
try {
  const offenders = []
  for (const file of ['../src/tools.js', '../src/index.js', '../src/priority.js']) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    text.split(/\r?\n/).forEach((line, index) => {
      if (/required:\s*false/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file}:${index + 1}`)
    })
  }
  if (offenders.length === 0) ok('源码里没有 required:false 的写法', '（注释里提到它不算）')
  else bad('源码里仍有 required:false', offenders.join(', '))
} catch (error) {
  bad('扫描 required:false 失败', error instanceof Error ? error.message : String(error))
}

// ── 4d. 遗留控制信号：未消费的 control/shutdown 会让监督者一启动就自杀 ────────
// 实测确认：这个标记**真的中招过**——
//   13:36:56.413Z 监督者进入监督循环
//   13:36:56.414Z 收到 control/shutdown，执行受控关闭     ← 遗留标记
// 主星刚被拉起，监督者立刻又把它关掉，白白浪费一整轮（还要等心跳超时才会再试）。
// 所以这里从"只警告"升级成"**发现即隔离**"：**改名**而不是删除（可逆，人还能看到现场）。
try {
  const marker = path.join(DSH_HOME, 'binary-star', 'control', 'shutdown')
  // 这一项只对**自带 binary-star 守护**的部署有意义 —— 那套组件不在本仓库里。
  // 所以没有该目录时**跳过**，而不是报失败：别人没装那套东西不该让预检变红。
  if (!fs.existsSync(path.join(DSH_HOME, 'binary-star', 'control'))) {
    ok('跳过 control/shutdown 检查', '（本机没有 binary-star/control 目录 —— 属于可选的外部守护组件）')
  } else if (!fs.existsSync(marker)) {
    ok('没有遗留的 control/shutdown 标记', '（复盘记录里它曾导致守护进程自杀）')
  } else {
    const stat = fs.statSync(marker)
    const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60000)
    if (ageMinutes >= 5) {
      const parked = `${marker}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`
      fs.renameSync(marker, parked)
      ok('隔离了**陈旧**的 control/shutdown 标记', `存在 ${ageMinutes} 分钟 → 改名为 ${parked.split('/').pop()}（未删除，可回滚）`)
    } else {
      ok('control/shutdown 标记很新，不动它', `只有 ${ageMinutes} 分钟 —— 可能是**有意**的受控停止，留给监督者消费`)
    }
  }
} catch (error) {
  bad('检查/隔离 control/shutdown 失败', error instanceof Error ? error.message : String(error))
}

console.log(
  failures === 0
    ? '\n预检通过：**这次连挂载层都跑了**（不只是 import），重启主星后这三行应当都能正常挂载。\n'
    : `\n预检失败 ${failures} 项 —— **先别重启**，修完再重启。\n`,
)
process.exit(failures === 0 ? 0 : 1)
