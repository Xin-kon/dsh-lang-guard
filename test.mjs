/**
 * dsh-lang-guard 自测：用模拟宿主验证注册行为与降级路径。
 *
 * 运行：node test.mjs
 * 零测试框架依赖 —— 全部用 node:assert + 手写的小工具。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  apply,
  inject,
  name,
  normalizeConfig,
  probeHost,
  resolveConstraint,
  PRESETS
} from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 极简测试运行器 ──────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${title}`)
    console.error(`       ${error.message}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ── 模拟宿主 ────────────────────────────────────────────────────────────────

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 构造一个模拟 DSH 宿主。
 * 每个开关对应真实宿主的一处 API，用来验证能力探测与降级。
 */
function makeHost({
  withSection = true,
  withContext = true,
  withEvents = true,
  withEffect = true,
  withCentralOrders = false,
  sectionThrows = false,
  logger = null
} = {}) {
  const registeredSections = []
  const registeredContexts = []
  const listeners = new Map()
  const effects = []
  const logs = { info: [], warn: [], error: [], debug: [] }

  // 每次构造一个全新的 logger：先记录，再调用调用方提供的原始方法
  // （原始方法若主动抛错，就能真实覆盖 createLogger 的 try/catch 回退分支）。
  const hostLogger = {}
  for (const level of Object.keys(logs)) {
    const original = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
    hostLogger[level] = (message) => {
      logs[level].push(String(message))
      if (original) original(message)
    }
  }

  const ctx = {
    logger: hostLogger,
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    }
  }

  ctx.systemPrompt = {}

  if (withSection) {
    ctx.systemPrompt.section = (payload) => {
      if (sectionThrows) throw new Error('模拟：section() 因 API 变更不可用')
      if (!Number.isFinite(payload.order)) throw new TypeError('order must be finite')
      if (registeredSections.some((s) => s.name === payload.name)) {
        throw new Error(`duplicate section "${payload.name}"`)
      }
      registeredSections.push(payload)
      return () => {}
    }
  }

  if (withContext) {
    ctx.systemPrompt.context = (payload) => {
      if (!Number.isFinite(payload.order)) throw new TypeError('order must be finite')
      registeredContexts.push(payload)
      return () => {}
    }
  }

  if (withCentralOrders) {
    ctx.systemPrompt.getSectionOrder = (key) => (key === 'HARNESS_IDENTITY' ? -1000 : 0)
  }

  if (!withEvents) delete ctx.on
  if (!withEffect) delete ctx.effect

  return { ctx, registeredSections, registeredContexts, listeners, effects, logs }
}

/** 触发一次 system-prompt/assemble 瀑布，返回最终 assembly。 */
async function runAssembly(host, assembly) {
  const handlers = host.listeners.get('system-prompt/assemble') ?? []
  let result = assembly
  let index = 0
  const next = async () => {
    const handler = handlers[index]
    index += 1
    if (!handler) return result
    return handler(result, {}, next)
  }
  return next()
}

// ── 测试 ────────────────────────────────────────────────────────────────────

section('A. 包契约与静态检查')

test('导出 name / inject / apply 且默认导出齐全', () => {
  assert.equal(name, 'lang-guard')
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(typeof apply, 'function')
})

test('index.js 不含任何 import —— 保证零运行时依赖', () => {
  const source = readFileSync(join(HERE, 'index.js'), 'utf8')
  assert.ok(!/^\s*import\s/m.test(source), 'index.js 不应出现 import 语句')
  assert.ok(!/\brequire\s*\(/.test(source), 'index.js 不应出现 require()')
})

test('package.json 无 dependencies / peerDependencies / engines', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined, '不应有 dependencies')
  assert.equal(pkg.peerDependencies, undefined, '不应有 peerDependencies（避免未来版本解析冲突）')
  assert.equal(pkg.engines, undefined, '不应锁定 engines')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

section('B. 配置归一化')

test('空配置使用默认值', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.preset, 'zh-think-answer')
  assert.equal(cfg.order, -200)
  assert.equal(cfg.contextOrder, -199)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.reinforce, true)
  assert.equal(cfg.sectionName, 'lang-guard:constraint')
  assert.deepEqual(cfg.issues, [])
})

test('非法 order（NaN / Infinity / 字符串）回退并记录问题', () => {
  for (const bad of [NaN, Infinity, 'abc', null]) {
    const cfg = normalizeConfig({ order: bad })
    assert.equal(cfg.order, -200, `order=${String(bad)} 应回退`)
    assert.ok(cfg.issues.length > 0, '应记录一条 issue')
  }
})

test('未知 preset 回退到默认并记录问题', () => {
  const cfg = normalizeConfig({ preset: 'does-not-exist' })
  assert.equal(cfg.preset, 'zh-think-answer')
  assert.ok(cfg.issues.some((i) => i.includes('未知 preset')))
})

test('所有内置预设都有非空文本', () => {
  for (const [key, text] of Object.entries(PRESETS)) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 20, `预设 ${key} 文本过短`)
  }
})

test('自定义 text 覆盖 preset', () => {
  const cfg = normalizeConfig({ preset: 'zh-strict', text: '只用中文。' })
  assert.equal(resolveConstraint(cfg), '只用中文。')
})

test('text 为空白字符串时不覆盖 preset', () => {
  const cfg = normalizeConfig({ text: '   ' })
  assert.equal(resolveConstraint(cfg), PRESETS['zh-think-answer'])
})

test('extraSections 中与主约束重名的项被过滤', () => {
  const cfg = normalizeConfig({
    extraSections: [
      { name: 'lang-guard:constraint', order: -100, text: '撞名' },
      { name: 'extra:ok', order: -50, text: '正常' }
    ]
  })
  assert.equal(cfg.extraSections.length, 1)
  assert.equal(cfg.extraSections[0].name, 'extra:ok')
  assert.ok(cfg.issues.some((i) => i.includes('重名')))
})

test('文本含 {{ 时给出插值预警', () => {
  const cfg = normalizeConfig({ text: '请输出 {{target}} 语言' })
  assert.ok(cfg.issues.some((i) => i.includes('模板插值')))
})

test('reinforceText 含 {{ 时给出预警（context 无逃生通道）', () => {
  const cfg = normalizeConfig({ reinforceText: '强化 {{x}} 文本' })
  assert.ok(cfg.issues.some((i) => i.includes('reinforceText') && i.includes('没有 interpolate 逃生通道')))
})

test('extraSections 文本含 {{ 时给出预警', () => {
  const cfg = normalizeConfig({
    extraSections: [{ name: 'extra:a', order: -100, text: '含 {{var}} 的扩展' }]
  })
  assert.ok(cfg.issues.some((i) => i.includes('extraSections')))
})

test('extra section 与强化 context 同名不冲突（按注册表分开去重）', () => {
  const cfg = normalizeConfig({
    contextName: 'same:name',
    extraSections: [{ name: 'same:name', order: -100, text: '扩展文本' }]
  })
  assert.equal(cfg.extraSections.length, 1, '与 context 同名不应被过滤')
})

test('两个 extraSections 互相重名时后者被过滤', () => {
  const cfg = normalizeConfig({
    extraSections: [
      { name: 'dup', order: -100, text: '第一个' },
      { name: 'dup', order: -101, text: '第二个' }
    ]
  })
  assert.equal(cfg.extraSections.length, 1)
  assert.equal(cfg.extraSections[0].text, '第一个')
  assert.ok(cfg.issues.some((i) => i.includes('重名')))
})

test('extraSections[].text 非字符串时跳过并给出准确提示', () => {
  const cfg = normalizeConfig({ extraSections: [{ name: 'a', order: -100, text: 12345 }] })
  assert.equal(cfg.extraSections.length, 0)
  assert.ok(cfg.issues.some((i) => i.includes('必须是字符串')))
})

test('extraSections[].text 为空白时跳过', () => {
  const cfg = normalizeConfig({ extraSections: [{ name: 'a', order: -100, text: '   ' }] })
  assert.equal(cfg.extraSections.length, 0)
  assert.ok(cfg.issues.some((i) => i.includes('为空')))
})

test('extraSections 不是数组时忽略并提示', () => {
  const cfg = normalizeConfig({ extraSections: 'oops' })
  assert.deepEqual(cfg.extraSections, [])
  assert.ok(cfg.issues.some((i) => i.includes('必须是数组')))
})

test('extraSections 中的非对象项被跳过', () => {
  const cfg = normalizeConfig({ extraSections: [null, 'x', { name: 'ok', order: -100, text: '文本' }] })
  assert.equal(cfg.extraSections.length, 1)
  assert.equal(cfg.extraSections[0].name, 'ok')
  assert.equal(cfg.issues.filter((i) => i.includes('不是对象')).length, 2)
})

test('extraSections 省略 name 时自动生成唯一名称', () => {
  const cfg = normalizeConfig({ extraSections: [{ order: -100, text: '甲' }, { order: -101, text: '乙' }] })
  assert.equal(cfg.extraSections.length, 2)
  assert.notEqual(cfg.extraSections[0].name, cfg.extraSections[1].name)
})

test('preset 为非字符串时回退并提示', () => {
  const cfg = normalizeConfig({ preset: 42 })
  assert.equal(cfg.preset, 'zh-think-answer')
  assert.ok(cfg.issues.some((i) => i.includes('未知 preset')))
})

test('preset 名为原型上的属性名时不被接受', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const cfg = normalizeConfig({ preset: key })
    assert.equal(cfg.preset, 'zh-think-answer', `preset=${key} 必须被拒绝`)
  }
})

test('reinforceText 非字符串时使用内置默认值', () => {
  const cfg = normalizeConfig({ reinforceText: 999 })
  assert.ok(cfg.reinforceText.includes('语言约束'))
  assert.deepEqual(cfg.issues, [])
})

test('sectionName 为空白时回退默认名', () => {
  const cfg = normalizeConfig({ sectionName: '   ' })
  assert.equal(cfg.sectionName, 'lang-guard:constraint')
  assert.ok(cfg.issues.some((i) => i.includes('sectionName')))
})

test('interpolate 非布尔值时按 auto 处理', () => {
  const cfg = normalizeConfig({ interpolate: 'yes' })
  assert.equal(cfg.interpolate, 'auto')
  assert.ok(cfg.issues.some((i) => i.includes('interpolate')))
})

test('enabled 非布尔值时回退为 true 并提示', () => {
  const cfg = normalizeConfig({ enabled: 'false' })
  assert.equal(cfg.enabled, true)
  assert.ok(cfg.issues.some((i) => i.includes('enabled')))
})

section('C. 能力探测')

test('完整 0.2 宿主：识别全部能力', () => {
  const { ctx } = makeHost({ withCentralOrders: true })
  const caps = probeHost(ctx)
  assert.equal(caps.section, true)
  assert.equal(caps.context, true)
  assert.equal(caps.events, true)
  assert.equal(caps.effect, true)
  assert.equal(caps.centralOrders, true)
})

test('精简 0.1 宿主：centralOrders 为 false', () => {
  const { ctx } = makeHost({ withCentralOrders: false })
  assert.equal(probeHost(ctx).centralOrders, false)
})

test('空 ctx 不抛错', () => {
  const caps = probeHost(undefined)
  assert.equal(caps.section, false)
  assert.equal(caps.events, false)
})

test('systemPrompt 服务对象的属性是抛错访问器时探测不崩', () => {
  const hostileService = {}
  for (const key of ['section', 'context', 'getSectionOrder']) {
    Object.defineProperty(hostileService, key, {
      enumerable: true,
      get() { throw new Error(`访问 ${key} 时抛错`) }
    })
  }
  const caps = probeHost({ systemPrompt: hostileService })
  assert.equal(caps.section, false)
  assert.equal(caps.context, false)
  assert.equal(caps.centralOrders, false)
})

section('D. 正常注册路径')

test('注册主约束 section：名称、order、文本为函数', () => {
  const host = makeHost({ withCentralOrders: true })
  apply(host.ctx, {})
  assert.equal(host.registeredSections.length, 1)
  const s = host.registeredSections[0]
  assert.equal(s.name, 'lang-guard:constraint')
  assert.equal(s.order, -200)
  assert.equal(typeof s.text, 'function', 'text 必须是函数以实现每步重新求值')
  assert.ok(s.text().includes('简体中文'))
})

test('每步重新求值时文本稳定可复现', () => {
  const host = makeHost({})
  apply(host.ctx, { text: '固定文本' })
  const s = host.registeredSections[0]
  assert.equal(s.text(), '固定文本')
  assert.equal(s.text(), '固定文本')
})

test('0.2 宿主自动带上 interpolate:false；0.1 宿主省略该字段', () => {
  const modern = makeHost({ withCentralOrders: true })
  apply(modern.ctx, {})
  assert.equal(modern.registeredSections[0].interpolate, false)

  const legacy = makeHost({ withCentralOrders: false })
  apply(legacy.ctx, {})
  assert.ok(!('interpolate' in legacy.registeredSections[0]), '旧宿主不应收到 interpolate 字段')
})

test('显式 interpolate:true 时尊重用户设置（省略该字段）', () => {
  const host = makeHost({ withCentralOrders: true })
  apply(host.ctx, { interpolate: true })
  assert.ok(!('interpolate' in host.registeredSections[0]))
})

test('显式 interpolate:false 且在支持的宿主上会传 false', () => {
  const host = makeHost({ withCentralOrders: true })
  apply(host.ctx, { interpolate: false })
  assert.equal(host.registeredSections[0].interpolate, false)
})

test('要求字面量但宿主不支持时给出降级告警', () => {
  const host = makeHost({ withCentralOrders: false })
  apply(host.ctx, { interpolate: false })
  assert.ok(host.logs.warn.some((m) => m.includes('不支持 interpolate 字段')))
})

test('注册强化 context，order 正确', () => {
  const host = makeHost({})
  apply(host.ctx, {})
  assert.equal(host.registeredContexts.length, 1)
  assert.equal(host.registeredContexts[0].name, 'lang-guard:reinforcement')
  assert.equal(host.registeredContexts[0].order, -199)
  assert.ok(host.registeredContexts[0].text().includes('语言约束'))
})

test('reinforce:false 时不注册强化 context', () => {
  const host = makeHost({})
  apply(host.ctx, { reinforce: false })
  assert.equal(host.registeredContexts.length, 0)
})

test('extraSections 一并注册', () => {
  const host = makeHost({})
  apply(host.ctx, {
    extraSections: [{ name: 'extra:a', order: -150, text: '补充约束 A' }]
  })
  const names = host.registeredSections.map((s) => s.name)
  assert.deepEqual(names, ['lang-guard:constraint', 'extra:a'])
})

test('enabled:false 时完全不注册', () => {
  const host = makeHost({})
  apply(host.ctx, { enabled: false })
  assert.equal(host.registeredSections.length, 0)
  assert.equal(host.registeredContexts.length, 0)
  assert.ok(host.logs.info.some((m) => m.includes('已禁用')))
})

test('注册走 ctx.effect 以便随插件卸载一起释放', () => {
  const host = makeHost({})
  apply(host.ctx, {})
  assert.ok(host.effects.some((e) => e.label.includes('lang-guard:constraint')))
})

section('E. 降级路径')

test('缺少 section() 时切到瀑布兜底', async () => {
  const host = makeHost({ withSection: false })
  apply(host.ctx, {})
  assert.equal(host.registeredSections.length, 0)
  assert.ok(host.listeners.has('system-prompt/assemble'), '应挂上瀑布监听')
  assert.ok(host.logs.warn.some((m) => m.includes('瀑布兜底')))

  const result = await runAssembly(host, {
    sections: [{ name: 'identity', text: 'harness identity' }],
    contexts: [],
    tools: [],
    variables: {}
  })
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0].name, 'lang-guard:constraint', '兜底应前插到最前')
  assert.ok(result.sections[0].text.includes('简体中文'))
})

test('section() 抛错时也切到瀑布兜底', async () => {
  const host = makeHost({ sectionThrows: true })
  apply(host.ctx, {})
  assert.ok(host.logs.warn.some((m) => m.includes('注册') && m.includes('失败')))
  assert.ok(host.listeners.has('system-prompt/assemble'))

  const result = await runAssembly(host, { sections: [], contexts: [], tools: [], variables: {} })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, 'lang-guard:constraint')
})

test('兜底路径不重复注入已存在的同名 section', async () => {
  const host = makeHost({ withSection: false })
  apply(host.ctx, {})
  const result = await runAssembly(host, {
    sections: [{ name: 'lang-guard:constraint', text: '已存在' }],
    contexts: [],
    tools: [],
    variables: {}
  })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].text, '已存在')
})

test('宿主完全没有 systemPrompt 与事件系统时不抛错，只记 error', () => {
  const host = makeHost({ withSection: false, withContext: false, withEvents: false })
  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.ok(host.logs.error.some((m) => m.includes('未能注册核心语言约束')))
})

test('ctx 完全为空对象时不抛错', () => {
  assert.doesNotThrow(() => apply({}, {}))
  assert.doesNotThrow(() => apply(undefined, undefined))
})

test('ctx 的属性访问器抛错（代理类宿主）时不崩溃', () => {
  const hostile = {}
  for (const key of ['systemPrompt', 'logger', 'config', 'on', 'effect']) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() { throw new Error(`访问 ${key} 时抛错`) }
    })
  }
  assert.doesNotThrow(() => apply(hostile, {}))
})

test('logger 的方法级是抛错访问器时不崩溃且不影响注册', () => {
  const hostileLogger = {}
  for (const level of ['info', 'warn', 'error', 'debug']) {
    Object.defineProperty(hostileLogger, level, {
      enumerable: true,
      get() { throw new Error(`访问 ${level} 时抛错`) }
    })
  }
  const sections = []
  const contexts = []
  const ctx = {
    logger: hostileLogger,
    systemPrompt: {
      section: (p) => { sections.push(p); return () => {} },
      context: (p) => { contexts.push(p); return () => {} }
    }
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(sections.length, 1, '日志不可用不应影响注册')
  assert.equal(contexts.length, 1)
})

test('宿主 logger 抛错时回退 console 不崩', () => {
  const badLogger = {
    info() { throw new Error('logger 坏了') },
    warn() { throw new Error('logger 坏了') },
    error() { throw new Error('logger 坏了') },
    debug() { throw new Error('logger 坏了') }
  }
  const host = makeHost({ logger: badLogger })
  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.equal(host.registeredSections.length, 1, '日志失败不应影响注册')
})

test('ctx.effect 缺失时直接注册', () => {
  const host = makeHost({ withEffect: false })
  apply(host.ctx, {})
  assert.equal(host.registeredSections.length, 1)
})

test('配置通过 ctx.config 兜底传入也能生效', () => {
  const host = makeHost({})
  host.ctx.config = { text: '来自 ctx.config 的文本' }
  apply(host.ctx)
  assert.equal(host.registeredSections[0].text(), '来自 ctx.config 的文本')
})

section('F. 复审回归（第三轮修复项）')

test('兜底监听器由 ctx.effect 托管', () => {
  const host = makeHost({ withSection: false })
  apply(host.ctx, {})
  assert.ok(host.effects.some((e) => e.label.includes('assemble fallback')), '监听器应被 effect 托管')
})

test('兜底结构性失败只告警一次，不随请求刷屏', async () => {
  const host = makeHost({ withSection: false })
  apply(host.ctx, {})
  const bad = { contexts: [], tools: [], variables: {} }
  await runAssembly(host, bad)
  await runAssembly(host, bad)
  await runAssembly(host, bad)
  const warns = host.logs.warn.filter((m) => m.includes('结构不符合预期'))
  assert.equal(warns.length, 1)
})

test('注册失败时的异常对象是带抛错 getPrototypeOf 的 Proxy 也不崩', () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('getPrototypeOf 抛错') } })
  const ctx = {
    systemPrompt: { section: () => { throw hostile }, context: () => () => {} },
    on: () => () => true
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('配置对象带抛错 getter 时退化为默认配置且不崩', () => {
  const hostile = {}
  for (const key of ['preset', 'text', 'order', 'extraSections']) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() { throw new Error(`读取 ${key} 抛错`) }
    })
  }
  const host = makeHost({})
  assert.doesNotThrow(() => apply(host.ctx, hostile))
  assert.equal(host.registeredSections.length, 1, '应回退到默认约束并完成注册')
  assert.ok(host.registeredSections[0].text().includes('简体中文'))
  assert.ok(host.logs.warn.some((m) => m.includes('配置对象无法读取')))
})

test('enabled:false 时配置问题仍会被报告', () => {
  const host = makeHost({})
  apply(host.ctx, { enabled: false, order: 'bad' })
  assert.ok(host.logs.warn.some((m) => m.includes('order')))
})

test('getSectionOrder 探测抛错时记录 probeError 并告警', () => {
  const host = makeHost({ withSection: false, withEvents: false })
  host.ctx.systemPrompt.getSectionOrder = () => { throw new Error('探测失败') }
  apply(host.ctx, {})
  assert.ok(host.logs.warn.some((m) => m.includes('能力探测异常')))
})

test('主约束失败但 context 成功时 error 文案如实说明 context 已注册', () => {
  const host = makeHost({ withSection: false, withEvents: false })
  apply(host.ctx, {})
  const line = host.logs.error.find((m) => m.includes('未能注册核心语言约束'))
  assert.ok(line, '应记录 error')
  assert.ok(line.includes('强化 context 已注册'), `文案应说明 context 已注册，实际：${line}`)
})

test('旧宿主 + 文本含 {{ 时给出阻塞级 error（0.2 宿主则不会）', () => {
  const legacy = makeHost({ withCentralOrders: false })
  apply(legacy.ctx, { text: '含 {{x}} 的文本' })
  assert.ok(legacy.logs.error.some((m) => m.includes('中断请求')))

  const modern = makeHost({ withCentralOrders: true })
  apply(modern.ctx, { text: '含 {{x}} 的文本' })
  assert.ok(!modern.logs.error.some((m) => m.includes('中断请求')), '0.2 宿主有 interpolate:false 兜底，不该报阻塞错误')
})

test('显式 interpolate:true 时即便含 {{ 也不报阻塞错误（用户已接管）', () => {
  for (const centralOrders of [true, false]) {
    const host = makeHost({ withCentralOrders: centralOrders })
    apply(host.ctx, { text: '含 {{x}} 的文本', interpolate: true })
    assert.ok(!host.logs.error.some((m) => m.includes('中断请求')), `centralOrders=${centralOrders} 时不应报阻塞错误`)
  }
})

test('order 为 0 是合法有限数，不应被当作缺失回退', () => {
  const cfg = normalizeConfig({ order: 0 })
  assert.equal(cfg.order, 0)
  assert.deepEqual(cfg.issues, [])
})

test('扩展项与主约束 order 相同可以共存（宿主按 order 再按 name 排序，不抛错）', () => {
  const host = makeHost({})
  apply(host.ctx, { extraSections: [{ name: 'extra:same', order: -200, text: '扩展' }] })
  assert.equal(host.registeredSections.length, 2)
})

test('sectionName 与 contextName 相同可以共存（独立注册表）', () => {
  const host = makeHost({})
  assert.doesNotThrow(() => apply(host.ctx, { sectionName: 'same', contextName: 'same' }))
  assert.equal(host.registeredSections[0].name, 'same')
  assert.equal(host.registeredContexts[0].name, 'same')
})

test('getSectionOrder 返回非有限数时 probeError 有值', () => {
  const ctx = { systemPrompt: { section: () => () => {}, getSectionOrder: () => 'not-a-number' } }
  const caps = probeHost(ctx)
  assert.equal(caps.centralOrders, false)
  assert.ok(caps.probeError && caps.probeError.includes('未返回有限数字'))
})

test('没有 getSectionOrder 时 probeError 保持 null（正常旧宿主）', () => {
  const ctx = { systemPrompt: { section: () => () => {} } }
  assert.equal(probeHost(ctx).probeError, null)
})

test('文本为函数注册但返回值预先算好（热路径无重复计算）', () => {
  const host = makeHost({})
  apply(host.ctx, { text: '固定文本' })
  const s = host.registeredSections[0]
  assert.equal(typeof s.text, 'function', '契约：仍以函数形式注册')
  assert.equal(s.text(), '固定文本')
})

section('G. 第三轮复审：安全边界与对外契约')

test('配置值中的换行不会伪造出额外日志行', () => {
  const host = makeHost({})
  // 用 order：非法值会被回显进 issue 消息，是真正会流经日志的路径。
  apply(host.ctx, { order: '第一行\n[INFO] 伪造的日志' })
  const all = [...host.logs.warn, ...host.logs.error, ...host.logs.info]
  assert.ok(all.some((m) => m.includes('⏎')), '换行应被替换为可见标记')
  for (const m of all) assert.ok(!/[\r\n]/.test(m), `日志不应含换行：${JSON.stringify(m)}`)
})

test('ANSI 控制序列不会进入日志', () => {
  const host = makeHost({})
  apply(host.ctx, { order: '第一行[31m红色[0m' })
  const all = [...host.logs.warn, ...host.logs.error, ...host.logs.info]
  assert.ok(all.some((m) => m.includes('红色')), '内容本身应保留')
  for (const m of all) assert.ok(!m.includes(''), `日志不应含 ESC：${JSON.stringify(m)}`)
})

test('resolveConstraint 对畸形输入也返回非空字符串（对外契约）', () => {
  assert.ok(resolveConstraint({ preset: 'zh-strict' }).length > 0, '缺 text 键时应回落到预设')
  assert.equal(resolveConstraint({ text: '  自定义  ' }), '自定义')
  assert.ok(resolveConstraint({}).length > 0)
  assert.ok(resolveConstraint(undefined).length > 0)
  assert.ok(resolveConstraint(null).length > 0)
  assert.ok(resolveConstraint({ preset: 'constructor' }).length > 0, '原型属性名不得被当成预设')
})

test('text 超长时回退预设并报 issue', () => {
  const cfg = normalizeConfig({ text: 'x'.repeat(9000) })
  assert.equal(cfg.text, '')
  assert.ok(cfg.issues.some((i) => i.includes('超过上限')))
})

test('reinforceText 超长时使用内置默认值并报 issue', () => {
  const cfg = normalizeConfig({ reinforceText: 'x'.repeat(5000) })
  assert.ok(cfg.reinforceText.includes('语言约束'))
  assert.ok(cfg.issues.some((i) => i.includes('超过上限')))
})

test('extraSections 超过数量上限时截断并报 issue', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `e${i}`, order: -100, text: '文本' }))
  const cfg = normalizeConfig({ extraSections: many })
  assert.equal(cfg.extraSections.length, 32)
  assert.ok(cfg.issues.some((i) => i.includes('超过上限')))
})

test('extraSections 单项文本超长时跳过并报 issue', () => {
  const cfg = normalizeConfig({ extraSections: [{ name: 'a', order: -100, text: 'x'.repeat(5000) }] })
  assert.equal(cfg.extraSections.length, 0)
  assert.ok(cfg.issues.some((i) => i.includes('超过上限')))
})

test('issue 数量超上限时折叠为一条汇总（防日志洪水）', () => {
  const bad = Array.from({ length: 50 }, () => 'not-an-object')
  const cfg = normalizeConfig({ extraSections: bad })
  assert.ok(cfg.issues.length <= 21, `issue 应被折叠，实际 ${cfg.issues.length} 条`)
  assert.ok(cfg.issues.some((m) => m.includes('已省略')))
})

test('宿主拒绝 interpolate 字段时自动重试并成功（不因可选字段掉进兜底）', () => {
  const sections = []
  const logs = []
  const logger = {}
  for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (m) => logs.push(`${level}: ${m}`)
  const ctx = {
    logger,
    effect: (fn) => { fn(); return () => {} },
    systemPrompt: {
      section: (p) => {
        if ('interpolate' in p) throw new Error('unknown key: interpolate')
        sections.push(p)
        return () => {}
      },
      getSectionOrder: () => -1000
    }
  }
  apply(ctx, {})
  assert.equal(sections.length, 1, '应去掉 interpolate 后重试成功')
  assert.ok(!('interpolate' in sections[0]))
  assert.ok(logs.some((m) => m.includes('重试成功')), '应记录降级重试')
  assert.ok(logs.some((m) => m.includes('瀑布兜底') === false), '不应退化到兜底路径')
})

test('ctx.effect 延迟执行（注册未发生）时不误报成功', () => {
  const sections = []
  const logs = []
  const logger = {}
  for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (m) => logs.push(`${level}: ${m}`)
  // effect 只记录回调、从不执行 —— 模拟延迟执行
  const ctx = {
    logger,
    effect: () => () => {},
    systemPrompt: {
      section: (p) => { sections.push(p); return () => {} },
      getSectionOrder: () => -1000
    }
  }
  apply(ctx, {})
  assert.equal(sections.length, 0, '注册未发生就不该记录成功')
  assert.ok(logs.some((m) => m.includes('延迟执行')))
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exitCode = 1
