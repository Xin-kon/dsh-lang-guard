/**
 * 真实集成测试：用官方 @deepseek-ai/dsh-system-prompt@0.2.0-rc.2 的真实实现
 * 驱动 dsh-lang-guard，不使用任何 mock。
 *
 * 前置条件（宿主包不在本插件的依赖里 —— 插件本身零依赖）：
 *   mkdir -p /tmp/dsh-itest && cd /tmp/dsh-itest
 *   npm init -y
 *   npm i @deepseek-ai/dsh-system-prompt@0.2.0-rc.2 @deepseek-ai/cordis@4.0.4
 *   # 然后从该目录运行本文件，或把它软链到该项目的 node_modules 下
 *
 * 运行：node test.integration.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
// 用相对路径定位被测插件，避免在源码里留下任何机器特定路径
import { apply, name, inject } from './index.js'

let pass = 0, fail = 0
const ok = (t, f) => { try { f(); pass++; console.log('  ok   ' + t) } catch (e) { fail++; console.error('  FAIL ' + t + '\n       ' + e.message) } }
const sec = (t) => console.log('\n' + t)

async function newHost(config = {}) {
  const ctx = new Context()
  ctx.provide('logger', { info(){}, warn(){}, error(){}, debug(){} })
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: true,
    includeRuntimeContext: true,
    personaPrefix: 'You are the deployment assistant.',
    ...config
  })
  return ctx
}

console.log('被测插件: name =', JSON.stringify(name), '| inject =', JSON.stringify(inject))
console.log('宿主: @deepseek-ai/dsh-system-prompt 真实实现（无 mock）\n')

sec('1. 插件能在真实宿主上挂载并注入')
const ctx1 = await newHost()
apply(ctx1, {})
const asm1 = await ctx1.systemPrompt.assemble()
const prompt1 = renderPrompt(asm1)
ok('assemble() 产出了包含中文约束的提示词', () => {
  if (!prompt1.includes('所有思考过程必须使用简体中文')) throw new Error('提示词中找不到约束文本')
})
ok('约束文本位于 persona 之前（order -200 生效）', () => {
  const iConstraint = prompt1.indexOf('所有思考过程必须使用简体中文')
  const iPersona = prompt1.indexOf('You are the deployment assistant.')
  if (iPersona < 0) throw new Error('persona 未出现在提示词中，无法比较位置')
  if (iConstraint > iPersona) throw new Error(`约束位置 ${iConstraint} 晚于 persona ${iPersona}`)
})
ok('约束落在 harness identity 之后（0.2 宿主 identity = -1000）', () => {
  const iId = prompt1.indexOf('powered by DeepSeek Harness')
  const iC = prompt1.indexOf('所有思考过程必须使用简体中文')
  if (iId < 0) throw new Error('未找到 harness identity 段')
  if (iC < iId) throw new Error('约束排在了 identity 之前')
})
ok('真实运行时 context 快照包含强化提醒', () => {
  const snap = renderContextSnapshot(asm1)
  if (!snap.includes('本约束每步刷新')) throw new Error('快照里没有强化文本，实际为：' + JSON.stringify(snap.slice(0, 200)))
})
ok('section 带 interpolate:false（0.2 宿主支持该字段）', () => {
  const s = asm1.sections.find(x => x.name === 'lang-guard:constraint')
  if (!s) throw new Error('未找到 lang-guard:constraint 段')
  if (s.interpolate !== false) throw new Error('interpolate = ' + JSON.stringify(s.interpolate))
})

sec('2. 真实宿主的 throw 点 —— 验证我们的校验确实拦住了它们')
const ctx2 = await newHost()
apply(ctx2, {})
ok('同层重名：真实宿主 section() 抛错（我们的去重才有意义）', () => {
  let threw = false
  try { ctx2.systemPrompt.section({ name: 'lang-guard:constraint', order: -1, text: 'x' }) }
  catch (e) { threw = true; if (!/already registered/.test(e.message)) throw new Error('抛的是别的错：' + e.message) }
  if (!threw) throw new Error('真实宿主竟然没抛错？我们的去重逻辑假设有误')
})
ok('order 非有限数：真实宿主 section() 抛错（我们的 pickFinite 才有意义）', () => {
  let threw = false
  try { ctx2.systemPrompt.section({ name: 'other', order: NaN, text: 'x' }) }
  catch (e) { threw = true; if (!/finite number/.test(e.message)) throw new Error('抛的是别的错：' + e.message) }
  if (!threw) throw new Error('真实宿主竟然没抛错？')
})
ok('未注册 {{变量}}：真实宿主 renderPrompt 抛错（我们的插值 lint 才有意义）', () => {
  const asm = { sections: [{ name: 'a', text: '含 {{nope}} 的文本' }], contexts: [], tools: [], variables: {} }
  let threw = false
  try { renderPrompt(asm) } catch { threw = true }
  if (!threw) throw new Error('真实宿主竟然没抛错？')
})

sec('3. 我们的插值保护在真实宿主上确实有效')
const ctx3 = await newHost()
apply(ctx3, { text: '语言约束：只用中文。{{marker}}' })
const asm3 = await ctx3.systemPrompt.assemble()
ok('文本含 {{}} 但因 interpolate:false 而被原样保留、未抛错', () => {
  const p = renderPrompt(asm3)
  if (!p.includes('{{marker}}')) throw new Error('字面量被插值掉了：' + JSON.stringify(p.slice(0, 300)))
})
const ctx3b = await newHost()
apply(ctx3b, { text: '语言约束：只用中文。', reinforceText: '强化 {{bad}} 文本' })
const asm3b = await ctx3b.systemPrompt.contexts ? await ctx3b.systemPrompt.assemble() : null
ok('context 类型无逃生通道：含 {{}} 会在渲染时抛错（故我们的 error 级告警是必要的）', () => {
  let threw = false
  try { renderContextSnapshot(asm3b) } catch { threw = true }
  if (!threw) throw new Error('context 竟然支持了字面量？那我们的告警文案需要修正')
})

sec('4. 禁用与降级')
const logs = []
const ctx4 = new Context()
await ctx4.plugin(SystemPrompt, {})
// cordis 内置 LoggerService 会覆盖 provide 的对象；改为在真实 logger 上挂捕获，
// 这样记录到的就是插件真正发出的日志。
const realLogger = ctx4.logger
for (const lv of ['info', 'warn', 'error', 'debug']) {
  const orig = realLogger[lv].bind(realLogger)
  realLogger[lv] = (m) => { logs.push([lv, String(m)]); orig(m) }
}
apply(ctx4, { enabled: false })
const asm4 = await ctx4.systemPrompt.assemble()
ok('enabled:false 时提示词里没有约束', () => {
  if (renderPrompt(asm4).includes('所有思考过程必须使用简体中文')) throw new Error('禁用了却还在注入')
})
ok('enabled:false 仍记录一条 info', () => {
  if (!logs.some(([lv, m]) => lv === 'info' && m.includes('已禁用'))) throw new Error('没有禁用日志')
})

sec('5. 自定义文本与预设生效')
const ctx5 = await newHost()
apply(ctx5, { preset: 'zh-strict' })
const p5 = renderPrompt(await ctx5.systemPrompt.assemble())
ok('preset=zh-strict 生效', () => {
  if (!p5.includes('不得输出英文整句')) throw new Error('未生效')
})
const ctx6 = await newHost()
apply(ctx6, { text: '我的自定义约束XYZ', preset: 'zh-strict' })
const p6 = renderPrompt(await ctx6.systemPrompt.assemble())
ok('自定义 text 覆盖 preset', () => {
  if (!p6.includes('我的自定义约束XYZ')) throw new Error('自定义未生效')
  if (p6.includes('不得输出英文整句')) throw new Error('preset 应被覆盖')
})

console.log(`\n${'─'.repeat(60)}`)
console.log(`真实集成测试：通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
