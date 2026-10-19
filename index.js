/**
 * dsh-lang-guard — DeepSeek Harness 语言约束插件
 * ============================================================================
 * 目标：用最小、最稳的方式把「Agent 必须用中文思考和回答」钉进系统提示词。
 *
 * 设计原则
 * ---------------------------------------------------------------------------
 * 1. **零运行时依赖**：全文不 import 任何模块。不引用 @deepseek-ai/*，
 *    因此不会因为宿主内部包改名/改版本而解析失败。
 * 2. **能力探测 + 双路径**：优先走官方 `systemPrompt.section()` 注册表；
 *    若该 API 在未来的版本里改名或消失，自动退到 `system-prompt/assemble`
 *    瀑布钩子；两条都不可用时只记日志、**绝不抛错**，不影响宿主启动。
 * 3. **静默降级**：任何一步失败都被捕获并转成可读日志。插件坏掉不应该
 *    拖垮整个 DSH。
 * 4. **配置持久化**：配置走 cordis.patch.yml（profile patch），不引入
 *    内存态 HTTP 配置端点 —— 因此没有重启丢失问题，也没有额外网络面。
 * 5. **可扩展**：内置 presets、支持任意自定义文本、支持额外注入任意
 *    section（extraSections），无需改代码即可扩展。
 *
 * 与 dsh-language-control 的关键差异：零依赖且不声明 peer/engines、配置持久化在
 * profile patch（对方是内存变量、重启丢失）、零网络面（对方 3 个 HTTP 路由）、
 * 只注入 systemPrompt、失败全链路降级而非直接抛出。
 * 逐项对比与选型建议见 README.md。
 *
 * 致谢
 * ---------------------------------------------------------------------------
 * 核心思路（向系统提示词顶部注入语言约束、每次推理前重新求值，以对抗工具返回
 * 外文后的语言漂移）来自 dsh-language-control（MIT）：
 *   https://github.com/wodongx123/dsh-language-control —— 作者 wodongx123
 * 本文件是在该思路基础上的重写，非其代码的衍生。完整署名见 README「致谢」一节。
 *
 * 兼容性
 * ---------------------------------------------------------------------------
 * 已核对 @deepseek-ai/dsh-system-prompt 的 0.1.0-rc.6 与 0.2.0-rc.2 类型定义，
 * 两者之间确实存在 API 漂移（本插件对每一处都做了适配）：
 *   - `PERSONA_SECTION` / `PERSONA_ORDER` 在 0.2 被拆成
 *     `PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`  → 本插件不引用这些常量
 *   - `PromptSection.interpolate` 是 0.2 新增                → 本插件按能力探测决定是否传
 *   - `getSectionOrder()` / `getContextOrder()` 是 0.2 新增  → 本插件仅用于探测与诊断
 *   - harness identity 的位置：0.1 无导出常量，仅注释约定在 -100；0.2 的中央表为
 *     HARNESS_IDENTITY = -1000。因此默认 order -200 在 **0.2** 落在 identity 之后、
 *     persona(0) 之前；在 **0.1** 则排在 identity(-100) 之前 —— 升序拼接下 -200 < -100，
 *     仍在 persona 之前，符合该代「其他负 order 也渲染在 persona 之前」的约定。
 *
 * @module dsh-lang-guard
 */

// ── 插件身份（Cordis 加载器读取）────────────────────────────────────────────

/** Cordis 插件名。 */
export const name = 'lang-guard'

/**
 * 只依赖 systemPrompt 一个服务。
 * 刻意不声明 webServer —— 本插件不需要 HTTP，少一个依赖就少一处版本风险。
 * 若宿主未来重命名该服务，apply 内的探测逻辑仍会给出明确诊断而不是静默失效。
 */
export const inject = ['systemPrompt']

// ── 常量与预设 ─────────────────────────────────────────────────────────────

const DEFAULT_SECTION_NAME = 'lang-guard:constraint'
const DEFAULT_CONTEXT_NAME = 'lang-guard:reinforcement'
const DEFAULT_ORDER = -200
// 强化 context 紧随主约束其后 —— 数值上直接体现「约束优先、提醒次之」。
const DEFAULT_CONTEXT_ORDER = DEFAULT_ORDER + 1
const DEFAULT_PRESET_KEY = 'zh-think-answer'

/** 触发「文本可能被宿主当成模板插值」的标记。 */
const INTERPOLATION_MARK = '{{'

// 配置输入的规模上限。信任边界上配置本就可信（能写它的人已有宿主控制权），
// 但一份失控或误粘贴的配置（例如 2MB 的 text）会让**每一次请求**都携带一个
// 巨大的系统提示词 —— 那是实打实的资源与体验问题，不是假设的攻击。
// 超限一律「回退默认 + 报 issue」，不静默接受。
const MAX_TEXT_LENGTH = 8192
const MAX_REINFORCE_LENGTH = 4096
const MAX_EXTRA_TEXT_LENGTH = 4096
const MAX_EXTRA_SECTIONS = 32
// 单次启动最多逐条报告多少个配置问题，超出则折叠为一条汇总，避免日志洪水。
const MAX_ISSUES = 20

/** 强化 context 的默认文本：这条会作为运行时快照进入会话历史，是防漂移的主力。 */
const DEFAULT_REINFORCE_TEXT = [
  '[语言约束]',
  '本约束每步刷新，优先级高于工具返回的内容。',
  '思考、规划、工具调用推理与最终回复一律使用简体中文。',
  '代码、命令、路径、日志原文与专有名词保持原样。'
].join(' ')

/**
 * 内置约束预设。`text` 配置项非空时会覆盖预设。
 * 所有预设都显式豁免代码/命令/路径/专有名词 —— 否则模型会把代码也"翻译"掉。
 */
export const PRESETS = {
  /** 默认：思考与回答全部中文。等价于 language-control 的默认强度。 */
  'zh-think-answer': [
    '你是中文 AI 助手，请严格遵循以下语言规范：',
    '1. 所有思考过程必须使用简体中文。',
    '2. 所有规划与任务拆解必须使用简体中文。',
    '3. 所有工具调用的推理必须使用简体中文。',
    '4. 最终回答必须使用简体中文，即使用户使用英文提问。',
    '5. 代码、命令、路径、标识符、错误信息原文与专有名词保持原样，不翻译。'
  ].join('\n'),

  /** 只约束推理过程，最终回答跟随用户提问语言。 */
  'zh-think-only': [
    '请遵循以下语言规范：',
    '1. 思考、规划与工具调用推理必须使用简体中文。',
    '2. 最终回答跟随用户提问所用的语言。',
    '3. 代码、命令、路径与专有名词保持原样，不翻译。'
  ].join('\n'),

  /** 更硬：显式禁止整句英文，并要求术语首次出现时附英文原词。 */
  'zh-strict': [
    '你是中文 AI 助手，必须严格使用简体中文工作。',
    '1. 思考过程、规划、工具调用推理与最终回答一律使用简体中文。',
    '2. 不得输出英文整句；英文仅允许出现在代码、命令、路径、日志原文与标识符中。',
    '3. 专业术语首次出现时用「中文（English）」形式标注，其后只用中文。',
    '4. 即使用户使用英文提问，也必须用简体中文思考和回答。',
    '5. 代码、命令、路径与错误信息原文保持原样，不翻译、不改写。'
  ].join('\n'),

  /** 英文对照版：供非中文场景或 A/B 对比使用。 */
  'en-think-answer': [
    'You are an English-speaking assistant. Follow these language rules strictly:',
    '1. All reasoning, planning and tool-call reasoning must be in English.',
    '2. All final answers must be in English, even if the user writes in another language.',
    '3. Keep code, commands, paths, identifiers and raw error messages exactly as-is.'
  ].join('\n')
}

// ── 配置归一化（手写，避免引入 schemastery）─────────────────────────────────

/**
 * 把任意来源的配置对象归一化成内部结构。
 * 不抛错：所有非法值都回退到默认值，并把问题记进 `issues` 供启动时打印。
 *
 * @param {unknown} raw 原始配置（来自 profile patch 的 `config:`）。
 * @returns 归一化后的配置对象，附 `issues: string[]`。
 */
export function normalizeConfig(raw) {
  // 配置读不出来时（最常见：YAML 缩进写错导致 config 变成一个字符串）必须
  // 留下线索，否则用户只会看到"用了默认预设"的静默行为。
  const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  const src = isObject ? raw : {}
  const issues = []
  if (raw !== undefined && raw !== null && !isObject) {
    issues.push(`config 必须是对象，收到 ${describe(raw)}，已忽略并全部使用默认配置。`)
  }

  // preset
  let preset = DEFAULT_PRESET_KEY
  if (src.preset !== undefined) {
    // 与 pickName 保持一致：YAML 里手抖带空格是常见误配，判定前先 trim。
    const key = typeof src.preset === 'string' ? src.preset.trim() : src.preset
    if (typeof key === 'string' && Object.hasOwn(PRESETS, key)) {
      preset = key
    } else {
      issues.push(`未知 preset ${describe(src.preset)}，已回退到 ${DEFAULT_PRESET_KEY}；可用值：${Object.keys(PRESETS).join(', ')}`)
    }
  }

  // 自定义文本（非空即覆盖 preset）
  const rawText = typeof src.text === 'string' ? src.text.trim() : ''
  let text = rawText
  if (src.text !== undefined && typeof src.text !== 'string') {
    issues.push('text 必须是字符串，已忽略该配置项。')
    text = ''
  } else if (typeof src.text === 'string' && src.text !== '' && rawText === '') {
    // 显式写了却只有空白：与 extraSections 的空 text 报 issue 的行为对齐，
    // 否则用户会拿到预设文案却毫无提示。（未配置 text 是正常默认，不在此提示。）
    issues.push('text 只有空白字符，已忽略并回退到预设文本。')
    text = ''
  } else if (rawText.length > MAX_TEXT_LENGTH) {
    issues.push(`text 长度 ${rawText.length} 超过上限 ${MAX_TEXT_LENGTH}，已忽略并回退到预设文本。`)
    text = ''
  }

  // order：必须是有限数，否则回退（NaN / Infinity 会让宿主 section() 抛错）
  const order = pickFinite(src.order, DEFAULT_ORDER, 'order', issues)
  const contextOrder = pickFinite(src.contextOrder, DEFAULT_CONTEXT_ORDER, 'contextOrder', issues)

  // 名称：必须是非空字符串，且不能互相撞车（宿主对同层重名会抛错）
  const sectionName = pickName(src.sectionName, DEFAULT_SECTION_NAME, 'sectionName', issues)
  const contextName = pickName(src.contextName, DEFAULT_CONTEXT_NAME, 'contextName', issues)

  // 布尔项：只认真正的 boolean，其余回退默认
  const enabled = pickBool(src.enabled, true, 'enabled', issues)
  const reinforce = pickBool(src.reinforce, true, 'reinforce', issues)
  const verbose = pickBool(src.verbose, false, 'verbose', issues)

  // interpolate：三态（true / false / 自动）。自动时由 apply 按宿主能力决定。
  let interpolate = 'auto'
  if (src.interpolate === true || src.interpolate === false) interpolate = src.interpolate
  else if (src.interpolate !== undefined) issues.push('interpolate 只接受布尔值或省略，已按「自动」处理。')

  // extraSections：可选的额外注入项，用于不改代码地扩展
  const extraSections = []
  if (src.extraSections !== undefined) {
    if (Array.isArray(src.extraSections)) {
      if (src.extraSections.length > MAX_EXTRA_SECTIONS) {
        issues.push(`extraSections 共 ${src.extraSections.length} 项，超过上限 ${MAX_EXTRA_SECTIONS}，仅处理前 ${MAX_EXTRA_SECTIONS} 项。`)
      }
      src.extraSections.slice(0, MAX_EXTRA_SECTIONS).forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          issues.push(`extraSections[${i}] 不是对象，已跳过。`)
          return
        }
        const n = pickName(entry.name, `${DEFAULT_SECTION_NAME}:extra${i}`, `extraSections[${i}].name`, issues)
        // 未指定 order 的扩展项默认排在主约束之后。sections 与 context 是两个
        // 独立注册表，所以这个默认值与 DEFAULT_CONTEXT_ORDER 数值相同也不会冲突。
        const o = pickFinite(entry.order, DEFAULT_ORDER + 1 + i, `extraSections[${i}].order`, issues)
        if (typeof entry.text !== 'string') {
          issues.push(`extraSections[${i}].text 必须是字符串，已跳过。`)
          return
        }
        const t = entry.text.trim()
        if (t === '') {
          issues.push(`extraSections[${i}].text 为空，已跳过。`)
          return
        }
        if (t.length > MAX_EXTRA_TEXT_LENGTH) {
          issues.push(`extraSections[${i}].text 长度 ${t.length} 超过上限 ${MAX_EXTRA_TEXT_LENGTH}，已跳过。`)
          return
        }
        extraSections.push({ name: n, order: o, text: t })
      })
    } else {
      issues.push('extraSections 必须是数组，已忽略。')
    }
  }

  // 去重：宿主在 sections 注册表里对重名会抛错。
  // 注意只按 sections 注册表去重 —— context 注册表是独立的命名空间，
  // extra section 与强化 context 同名并不冲突，不应被误拦。
  const seenSectionNames = new Set([sectionName])
  const uniqueExtras = extraSections.filter((s) => {
    if (seenSectionNames.has(s.name)) {
      issues.push(`extraSections 名称 ${describe(s.name)} 与主约束或其他扩展项重名（sections 注册表内重名会让宿主抛错），已跳过。`)
      return false
    }
    seenSectionNames.add(s.name)
    return true
  })

  // 强化文本
  const rawReinforce = typeof src.reinforceText === 'string' ? src.reinforceText.trim() : ''
  let reinforceText = rawReinforce
  if (rawReinforce.length > MAX_REINFORCE_LENGTH) {
    issues.push(`reinforceText 长度 ${rawReinforce.length} 超过上限 ${MAX_REINFORCE_LENGTH}，已忽略并使用内置默认值。`)
    reinforceText = ''
  }
  if (reinforceText === '') reinforceText = DEFAULT_REINFORCE_TEXT

  const cfg = {
    enabled,
    preset,
    text,
    order,
    contextOrder,
    sectionName,
    contextName,
    reinforce,
    reinforceText,
    extraSections: uniqueExtras,
    interpolate,
    verbose,
    issues
  }

  // 模板插值预警。
  // 依据 0.2.0-rc.2 宿主源码核实的事实：
  //  - renderPrompt 对 section 有 interpolate:false 逃生通道（0.2+），旧版没有；
  //  - renderContextSections 对 context **无条件插值**，且 PromptContext 没有
  //    interpolate 字段 —— 也就是说 context 文本里的 {{ 没有任何逃生通道；
  //  - 未注册的 {{变量}} 会让整次 assemble 直接抛错。
  // 因此对每一段要注入的文本都要检查。
  // 用 resolveConstraint 取「实际生效的文本」，避免与选文逻辑各写一份而分叉。
  const primaryProbe = resolveConstraint(cfg)
  if (primaryProbe.includes(INTERPOLATION_MARK)) {
    issues.push(`约束文本包含 "${INTERPOLATION_MARK}"；宿主默认会做模板插值，未注册的变量会导致组装失败。建议去掉，或显式设置 interpolate: false（0.2+ 宿主生效）。`)
  }
  if (cfg.reinforceText.includes(INTERPOLATION_MARK)) {
    issues.push(`reinforceText 包含 "${INTERPOLATION_MARK}"；context 注入没有 interpolate 逃生通道，宿主渲染时无条件插值，未注册的变量必然导致组装失败。请去掉。`)
  }
  for (const s of uniqueExtras) {
    if (s.text.includes(INTERPOLATION_MARK)) {
      issues.push(`extraSections（${s.name}）文本包含 "${INTERPOLATION_MARK}"；0.2+ 宿主上有 interpolate:false 兜底，旧宿主上会直接导致组装失败。建议去掉。`)
    }
  }

  // 单次启动的 issue 逐条打印，超出上限则折叠为一条汇总 ——
  // 一份有几百个坏扩展项的配置不该产出几千行 warn 把日志淹掉。
  if (issues.length > MAX_ISSUES) {
    const rest = issues.length - MAX_ISSUES
    issues.length = MAX_ISSUES
    issues.push(`另有 ${rest} 条同类配置问题已省略（单次启动最多逐条报告 ${MAX_ISSUES} 条）。`)
  }

  return cfg
}

function pickFinite(value, fallback, label, issues) {
  if (value === undefined) {
    return fallback
  }
  if (Number.isFinite(value)) return value
  issues.push(`${label} 必须是有限数字，收到 ${describe(value)}，已回退为 ${fallback}。`)
  return fallback
}

function pickName(value, fallback, label, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  issues.push(`${label} 必须是非空字符串，已回退为 ${describe(fallback)}。`)
  return fallback
}

function pickBool(value, fallback, label, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  issues.push(`${label} 必须是布尔值，收到 ${describe(value)}，已回退为 ${fallback}。`)
  return fallback
}

/**
 * 解析当前生效的约束文本。
 * 导出以便其他插件复用，也方便单测直接验证。
 *
 * 契约：传入的是**任意外部形状**的对象也能给出非空字符串 ——
 * 该函数会被其他插件直接调用，不能假设 cfg 一定出自 normalizeConfig。
 */
export function resolveConstraint(cfg) {
  const custom = typeof cfg?.text === 'string' ? cfg.text.trim() : ''
  if (custom !== '') return custom
  return Object.hasOwn(PRESETS, cfg?.preset) ? PRESETS[cfg.preset] : PRESETS[DEFAULT_PRESET_KEY]
}

// ── 宿主能力探测 ────────────────────────────────────────────────────────────

/**
 * 探测宿主实际提供了哪些 API，作为选择注册路径的依据。
 *
 * 不依赖任何版本号判断 —— 只做能力检测。后续 DSH 版本增删 API 时，
 * 这里的结果会自动变化，无需改代码。
 */
export function probeHost(ctx) {
  // ctx 及其承载的服务对象都可能是代理 / 带抛错访问器的对象；
  // 任何属性访问都要兜底，否则一个抛错的 getter 会让 apply 直接崩掉。
  const sp = safeGet(ctx, 'systemPrompt')
  const caps = {
    section: typeof safeGet(sp, 'section') === 'function',
    context: typeof safeGet(sp, 'context') === 'function',
    events: typeof safeGet(ctx, 'on') === 'function',
    effect: typeof safeGet(ctx, 'effect') === 'function'
  }

  // 尝试解析中央分配的位置。能拿到数字，说明宿主是 0.2 及以后的
  // 「中央 order 表」形态 —— 同时也是 interpolate 字段存在的可靠信号。
  caps.centralOrders = false
  // probeError 用于区分「宿主真的没有这个 API」与「探测本身失败了」，
  // 避免把一次探测异常伪装成「旧宿主」而静默降级。
  caps.probeError = null
  const getSectionOrder = safeGet(sp, 'getSectionOrder')
  if (typeof getSectionOrder === 'function') {
    try {
      // 用 call 保留 this，避免脱离宿主对象后方法内部的 this 失效。
      caps.centralOrders = Number.isFinite(getSectionOrder.call(sp, 'HARNESS_IDENTITY'))
      if (!caps.centralOrders) caps.probeError = 'getSectionOrder("HARNESS_IDENTITY") 未返回有限数字'
    } catch (error) {
      caps.probeError = describe(error)
    }
  }
  return caps
}

// ── 日志（宿主 logger 缺失时回退 console）───────────────────────────────────

/**
 * 日志净化：压成单行、剥掉 ANSI 控制序列。
 *
 * 配置值会被直接拼进日志消息。若不处理，一条含换行的配置就能伪造出额外的
 * 日志行（伪装成别的级别或别的插件），破坏排障证据。信任边界上配置本就可信，
 * 所以这不算是攻击面 —— 但"一处净化覆盖所有日志点"比"在每个调用点各自过滤"
 * 更简单也更可靠，因此值得做。
 */
function sanitizeForLog(message) {
  try {
    return String(message)
      .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
      .replace(/[\r\n]+/g, ' ⏎ ')
  } catch {
    return '（日志消息无法读取）'
  }
}

function createLogger(ctx, verbose) {
  const tag = `[${name}]`
  // 同 probeHost：ctx.logger 也可能是带抛错访问器的属性，读取要兜底。
  const host = safeGet(ctx, 'logger')
  const emit = (level, message) => {
    // host 的方法级属性同样可能是抛错访问器，一并兜底。
    const fn = safeGet(host, level)
    if (typeof fn === 'function') {
      try {
        fn.call(host, sanitizeForLog(message))
        return
      } catch {
        // 宿主的 logger 形状不对时静默回退
      }
    }
    const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fallback(`${tag} ${sanitizeForLog(message)}`)
  }
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    debug: (m) => { if (verbose) emit('debug', m) }
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * Cordis 插件入口。签名遵循 `apply(ctx, config)` 约定。
 *
 * 全程不抛错：任何异常都被捕获并转成日志，避免一个 UI 插件拖垮宿主启动。
 */
export function apply(ctx, config) {
  // 配置可能通过第二参数传入；部分宿主也会挂在 ctx.config 上，两者都兼容。
  const raw = config ?? safeGet(ctx, 'config') ?? {}

  // 配置归一化本身承诺不抛错，但配置对象若来自带抛错 getter 的 Proxy，
  // 属性读取仍可能逃逸。这里再兜一层：任何异常都退化为「全部默认」，
  // 绝不因为配置问题让 apply 抛出（宿主启动不受影响）。
  let cfg
  try {
    cfg = normalizeConfig(raw)
  } catch (error) {
    cfg = normalizeConfig({})
    cfg.issues.push(`配置对象无法读取（${describe(error)}），已全部回退为默认配置。`)
  }

  const log = createLogger(ctx, cfg.verbose)
  const caps = probeHost(ctx)

  if (cfg.verbose) log.debug(`能力探测：${JSON.stringify(caps)}`)

  // 配置问题无论是否启用都要报 —— 否则 enabled:false 会把配置错误一起藏起来。
  for (const issue of cfg.issues) log.warn(issue)

  if (caps.probeError && !caps.centralOrders) {
    log.warn(`能力探测异常：getSectionOrder() 调用失败（${caps.probeError}），已按「宿主不支持 interpolate 字段」处理。若该宿主其实支持，可忽略本条。`)
  }

  if (!cfg.enabled) {
    log.info('已禁用（config.enabled = false），未注册任何注入。')
    return
  }

  // 约束文本在插件生命周期内是常量：预先算好，热路径（每次 assemble）只做一次返回。
  // text 仍以函数形式注册 —— 宿主每次 assemble 都会重新求值，这个契约保持不变。
  const primaryText = resolveConstraint(cfg)
  const text = () => primaryText
  const reinforceText = () => cfg.reinforceText

  // 组装要注册的 section 列表：主约束 + 用户扩展项
  const sections = [
    { name: cfg.sectionName, order: cfg.order, text, primary: true },
    ...cfg.extraSections.map((s) => ({ name: s.name, order: s.order, text: () => s.text, primary: false }))
  ]

  // 兜底注入计划：**由 sections 派生**（单一数据源，不会与注册列表漂移），
  // 并按 sections 的反序预排好 —— unshift 语义下逆序注入的最终顺序才等于正序。
  const injectPlan = [...sections].reverse().map((s) => ({ name: s.name, text: s.text }))

  // 决定是否携带 interpolate 字段。
  // passLiteral：是否给宿主传 interpolate: false，即「把文本当字面量、禁掉插值」。
  // 命名刻意与宿主字段相反，避免读成「要不要开插值」。
  //   - 用户显式 interpolate: true → 不传（保留宿主默认的插值行为）
  //   - 其余情况（auto / false）→ 仅当宿主确实支持该字段时才传
  // 之所以要探测而不是无脑传：0.1.x 的 PromptSection 没有这个字段，
  // 万一它对未知键做严格校验，无脑传会直接让注册失败。
  let passLiteral = cfg.interpolate !== true && caps.centralOrders
  if (cfg.interpolate === false && !caps.centralOrders) {
    log.warn('当前宿主的 PromptSection 不支持 interpolate 字段，无法强制按字面量处理；若文本中含 "{{" 请手动去掉。')
  }
  // 阻塞级提示分两类，判定条件不同，不能合并：
  // (a) 强化 context —— 宿主对 context 无条件插值，且 PromptContext 没有
  //     interpolate 字段，**根本没有 opt-out 通道**。所以含 {{ 就必然阻塞，
  //     与宿主是否支持 interpolate 无关（在 0.2 宿主上也照样阻塞）。
  if (cfg.reinforce && cfg.reinforceText.includes(INTERPOLATION_MARK)) {
    log.error('强化 context 文本含 "{{"：宿主对 context 无条件插值且没有关闭开关，未注册的变量会导致每次组装时抛错并中断请求。请立即移除 "{{"。')
  }
  // (b) sections —— 仅在无法按字面量处理、且用户未显式保留插值时阻塞。
  //     排除 interpolate === true：那时用户已主动接管插值语义，不该报警。
  if (!passLiteral && cfg.interpolate !== true) {
    const risky = [primaryText, ...cfg.extraSections.map((s) => s.text)]
    if (risky.some((t) => t.includes(INTERPOLATION_MARK))) {
      log.error('当前宿主不支持 interpolate 字段，无法把文本按字面量处理，而配置文本中含 "{{"：这会导致每次组装系统提示词时抛错并中断请求。请立即从配置中移除 "{{"。')
    }
  }

  // 两条路径各自记账，不再共用一个含义模糊的标志位：
  //   sectionOk    —— 主约束已通过官方注册表生效
  //   fallbackHooked —— 兜底瀑布钩子已挂上（此时 order 不受控）
  let sectionOk = false
  let fallbackHooked = false

  // 注册全部 section；literal 决定是否携带 interpolate:false。
  // 成功判定以「serviceCall 真的被调用过」为准 —— ctx.effect 理论上可能延迟
  // 执行，那时仅凭「effect 没抛错」就宣布成功是错的（会同时污染 sectionOk）。
  const registerSections = (literal) => {
    let primary = false
    for (const s of sections) {
      const payload = { name: s.name, order: s.order, text: s.text }
      if (literal) payload.interpolate = false
      let registered = false
      try {
        const register = () => {
          const disposer = serviceCall(ctx, 'section', payload)
          registered = true
          return disposer
        }
        if (caps.effect) ctx.effect(register, `${name}: ${s.name}`)
        else register()
        if (!registered) throw new Error('宿主 ctx.effect 延迟执行，无法确认注册结果')
        if (s.primary) primary = true
        if (cfg.verbose) log.debug(`已注册 section "${s.name}"，order = ${s.order}${literal ? '，interpolate = false' : ''}`)
      } catch (error) {
        log.warn(`通过 systemPrompt.section() 注册 "${s.name}" 失败：${describe(error)}`)
      }
    }
    return primary
  }

  // ── 路径 A：官方注册表 ──────────────────────────────────────────────────
  if (caps.section) {
    sectionOk = registerSections(passLiteral)
    if (!sectionOk && passLiteral) {
      // 宿主可能对 PromptSection 做严格键校验、只认已知字段。若因 interpolate
      // 而整体注册失败，去掉该字段整体重试一次 —— 否则会为了一个可选字段掉到
      // 兜底路径，让 order 彻底失控。
      log.warn('携带 interpolate 字段时主约束注册失败，改为省略该字段整体重试一次。')
      if (registerSections(false)) {
        passLiteral = false
        log.warn('重试成功：本插件不再向宿主传递 interpolate 字段。')
      }
    }
  }

  // ── 路径 B：瀑布钩子兜底 ────────────────────────────────────────────────
  // 触发条件：主约束没注册上（而不是「一条都没注册上」—— 若主约束失败、
  // 扩展项侥幸成功，也必须兜底，否则核心功能静默缺失）。
  // 注意：组装后的 assembly.sections 只保留 name/text，**没有 order 字段**
  // （见 AssembledSection 类型），因此兜底路径只能前插到最前面，
  // 无法精确控制顺序 —— 这是有意的、可接受的降级。
  if (!sectionOk && caps.events) {
    // 结构性失败只告警一次：宿主形状不会中途改变，重复刷屏只会淹没日志。
    let reported = false
    const handler = async (assembly, _context, next) => {
      const result = await (typeof next === 'function' ? next() : assembly)
      if (!result || !Array.isArray(result.sections)) {
        if (!reported) {
          reported = true
          log.warn('瀑布兜底注入失败：宿主 assembly 结构不符合预期（sections 不是数组），后续不再重复告警。')
        }
        return result
      }
      try {
        for (const s of injectPlan) {
          if (result.sections.some((item) => item?.name === s.name)) continue
          // AssembledSection 同样支持 interpolate（渲染发生在瀑布之后），
          // 所以这条降级路径也能保住「按字面量处理」的能力。
          const injected = { name: s.name, text: s.text() }
          if (passLiteral) injected.interpolate = false
          result.sections.unshift(injected)
        }
      } catch (error) {
        if (!reported) {
          reported = true
          log.warn(`瀑布兜底注入失败：${describe(error)}`)
        }
      }
      return result
    }
    try {
      // 用 ctx.effect 托管监听器，与 section/context 的注册方式保持一致。
      // 依据：cordis 的 on() 本身即「owned by the current fiber」，随上下文释放；
      // 这里再托管一层是显式保证 —— 插件卸载或热重载后不留残留监听器。
      const register = () => ctx.on('system-prompt/assemble', handler)
      if (caps.effect) ctx.effect(register, `${name}: assemble fallback`)
      else register()
      fallbackHooked = true
      log.warn('systemPrompt.section() 不可用或注册失败，已切换到 system-prompt/assemble 瀑布兜底路径（无法精确控制 section 顺序）。')
    } catch (error) {
      log.warn(`注册瀑布兜底失败：${describe(error)}`)
    }
  }

  // ── 强化 context（防空转漂移）───────────────────────────────────────────
  let contextOk = false
  if (cfg.reinforce && caps.context) {
    const payload = { name: cfg.contextName, order: cfg.contextOrder, text: reinforceText }
    const register = () => serviceCall(ctx, 'context', payload)
    try {
      if (caps.effect) ctx.effect(register, `${name}: ${cfg.contextName}`)
      else register()
      contextOk = true
    } catch (error) {
      log.warn(`注册强化 context "${cfg.contextName}" 失败：${describe(error)}`)
    }
  }
  // ── 启动小结 ────────────────────────────────────────────────────────────
  if (!sectionOk && !fallbackHooked) {
    // 文案要与实际状态一致：强化 context 此时可能已经注册成功了，
    // 不能一概说成「插件保持静默」。
    log.error(contextOk
      ? '未能注册核心语言约束（宿主既无 systemPrompt.section 也无可用的事件系统）；强化 context 已注册，但语言约束本体未生效。插件不影响宿主运行。'
      : '未能注册核心语言约束（宿主既无 systemPrompt.section 也无可用的事件系统）。插件保持静默，不影响宿主运行；请确认当前 DSH 版本的 systemPrompt 服务是否可用。')
    return
  }

  const via = fallbackHooked ? '瀑布兜底' : '官方注册表'
  const presetLabel = cfg.text !== '' ? '自定义文本' : `预设 ${cfg.preset}`
  // 兜底路径只能前插、order 不受控 —— 此时不要报一个并不生效的 order 值。
  const orderLabel = sectionOk ? `，主约束 order = ${cfg.order}` : '，order 由兜底路径接管（不可控）'
  log.info(`已生效（${via}）：${sections.length} 条约束，${presetLabel}${orderLabel}${contextOk ? '，含强化 context' : ''}。`)
}

/**
 * 安全读取对象属性：读取本身抛错（带抛错访问器的 Proxy 宿主）时返回 undefined。
 *
 * 这是纵深防御，不是已知的攻击面 —— 真实 Cordis ctx 是普通对象，读属性不会抛。
 * 保留它的理由只有一条：「插件绝不能把宿主启动搞崩」是本插件的硬承诺，而实现
 * 代价只是一层 try。去掉它就得重新论证每一处 ctx 读取，不划算。
 */
function safeGet(obj, key) {
  try {
    return obj?.[key]
  } catch {
    return undefined
  }
}

/**
 * 调用宿主 systemPrompt 服务上的方法。
 * 服务对象与方法都走 safeGet 兜底；失败时抛出可读错误 ——
 * 所有调用点都在 try/catch 内，因此不会让 apply 抛出。
 * 用 call 传入宿主对象，避免方法内部的 this 失效。
 */
function serviceCall(ctx, method, argument) {
  const service = safeGet(ctx, 'systemPrompt')
  if (!service) throw new Error(`systemPrompt 服务不可用，无法调用 ${method}()`)
  const fn = safeGet(service, method)
  if (typeof fn !== 'function') throw new Error(`systemPrompt.${method} 不是函数（宿主 API 可能已变更）`)
  return fn.call(service, argument)
}

/** 把任意异常转成一行可读描述。本函数自己也不能抛 —— 它服务于各个 catch 块。 */
function describe(error) {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return JSON.stringify(error)
  } catch {
    // 异常对象本身可能是带抛错访问器的 Proxy —— 任何读取都不能再抛。
    return '（异常对象无法读取）'
  }
}

// ── 默认导出（加载器按 default 取插件对象）─────────────────────────────────

export default { name, inject, apply }
