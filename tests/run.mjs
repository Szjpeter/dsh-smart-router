// dsh-smart-router — 测试 runner（沙箱内直接执行，不经 node --test 子进程）
// 运行：node tests/run.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))

const cases = []
export function test(name, fn) {
  cases.push({ name, fn })
}

let pass = 0
let fail = 0

// ── 导入被测模块 ──
async function run() {
  const { evaluateComplexity, keywordScore, DEFAULT_LIGHT_KEYWORDS, DEFAULT_HEAVY_KEYWORDS } = await import('../lib/keywords.js')
  const { resolveConfig } = await import('../lib/settings.js')
  const {
    decideTarget, PRO_MODEL, FLASH_MODEL, extractTaskText,
    readSessionUsedTokens, sessionBudgetOver, hasPendingFallback,
    installRouter,
  } = await import('../lib/router.js')
  const {
    classifyReasoning, promotionState, isProAnchored, isFlashAnchored,
    effectiveModel, installBoost,
  } = await import('../lib/boost.js')

  const baseCfg = {
    lightKeywords: ['搜索', '查询', '翻译', '总结', 'search', 'list', 'quick'],
    heavyKeywords: ['重构', '架构', '设计', '调试', '优化', 'refactor', 'architecture', 'debug'],
    shortTaskMaxChars: 60,
    unknownToFlash: false,
    peakDemoteUnknown: false,
    peakHours: [[9, 12], [14, 18]],
    budgetCapTokens: 0,
    enabled: true,
    routeMainSession: false,
    routeSubagents: true,
    proBoost: true,
    flashBoost: true,
    proAnchorTools: ['bash', 'str_replace_editor', 'pwsh', 'edit'],
    flashAnchorTools: ['read', 'write', 'str_replace_editor', 'edit'],
    proMaxBootstrapSteps: 4,
    flashMaxBootstrapSteps: 2,
    anchorGate: true,
    promoteAfterFirstResponse: true,
    proPhase1MessageSources: ['user', 'goal'],
    bootstrapMaxTokens: 1024,
    fallbackOnError: true,
    ledgerEnabled: false,
  }

  // 共享状态工厂（与 index.js apply() 中一致）
  const mkShared = () => ({
    promotion: new WeakMap(),
    decision: new WeakMap(),
    sessionModes: new WeakMap(),
    fallbackMarks: new Map(),
    fallbackPending: new Map(),
    boostTargets: new Set([PRO_MODEL, FLASH_MODEL]),
    anchorGate: true,
    promoteAfterFirstResponse: true,
    proMaxBootstrapSteps: 4,
  })

  // 极简宿主桩：收集挂钩处理器供直接调用
  function makeCtx() {
    const handlers = {}
    return {
      handlers,
      on(name, fn) { (handlers[name] ??= []).push(fn) },
      logger: { info() {}, warn() {}, debug() {} },
      commands: { register() {} },
    }
  }

  // ── keywordScore ──
  test('keywordScore: ASCII 词边界（list 不匹配 specialist）', () => {
    assert.equal(keywordScore('specialist analysis', ['list']), 0)
    assert.equal(keywordScore('list all files', ['list']), 1)
  })
  test('keywordScore: CJK 直接包含', () => {
    assert.equal(keywordScore('请翻译这段文字', ['翻译']), 1)
  })
  test('keywordScore: 表内重复关键词去重（不再叠加权重）', () => {
    assert.equal(keywordScore('good design', ['design', 'design']), 1)
  })
  test('keywordScore: 匹配器缓存复用后结果一致', () => {
    const kws = ['alpha', '中文词']
    const a = keywordScore('alpha 与 中文词', kws)
    assert.equal(keywordScore('alpha 与 中文词', kws), a)
    assert.equal(a, 2)
  })
  test('keywordScore: 非 string / 空串条目安全跳过', () => {
    assert.equal(keywordScore('x y', ['x', '', null, 'y']), 2)
  })

  // ── evaluateComplexity ──
  test('evaluateComplexity: heavy 支配规则（heavy >= light 才赢）', () => {
    const r = evaluateComplexity('请重构这个模块并优化性能，把架构调整成事件驱动，全面分析现有实现的缺陷', baseCfg)
    assert.equal(r.verdict, 'heavy')
  })
  test('evaluateComplexity: light 可否决 heavy', () => {
    const r = evaluateComplexity('请帮我搜索并翻译这段文字，顺便总结一下要点，列出主要内容，再查询一下相关背景资料', baseCfg)
    assert.equal(r.verdict, 'light')
  })
  test('evaluateComplexity: 短任务 → short', () => {
    assert.equal(evaluateComplexity('你好', baseCfg).verdict, 'short')
  })
  test('evaluateComplexity: 未知 → unknown', () => {
    const long = '今天天气怎么样？中午吃什么？晚上要不要看电影？周末有没有空一起去爬山？顺便问问你最近读的那本书好不好看，还有昨天说的那家餐厅怎么样，值不值得专门跑一趟去试试？'
    assert.equal(evaluateComplexity(long, baseCfg).verdict, 'unknown')
  })

  // ── 默认词表回归（口语高频词已在 heavy→light 调整后不再误判重型）──
  const defaultCfg = resolveConfig({}, { light: DEFAULT_LIGHT_KEYWORDS, heavy: DEFAULT_HEAVY_KEYWORDS })
  test('默认词表: "你可以测试" 不再判 heavy（口语词入 light）', () => {
    const r = evaluateComplexity('现在是ds-flash 大模型了 你可以测试', defaultCfg)
    assert.equal(r.verdict, 'light', '测试 移入 light → 闲聊走轻')
  })
  test('默认词表: 架构设计任务仍判 heavy（heavy=12 压倒 light=1）', () => {
    const r = evaluateComplexity('请完成以下架构设计任务：设计并分析分布式微服务网关的整体架构，评估性能瓶颈、并发模型与安全边界，并给出完整的重构方案与实现规划。', defaultCfg)
    assert.equal(r.verdict, 'heavy')
    assert.ok(r.heavy > r.light)
  })
  test('默认词表: 支配规则仍工作（重构+写单元测试 → heavy 保留）', () => {
    const r = evaluateComplexity('重构这个模块并写单元测试', defaultCfg)
    assert.equal(r.verdict, 'heavy')
  })
  test('默认词表: 单独"写单元测试" → light', () => {
    assert.equal(evaluateComplexity('写单元测试', defaultCfg).verdict, 'light')
  })

  // ── decideTarget ──
  test('decideTarget: light 在 Pro 上 → Flash', () => {
    assert.equal(decideTarget({ verdict: 'light' }, baseCfg, PRO_MODEL), FLASH_MODEL)
  })
  test('decideTarget: light 在 Flash 上 → 保持', () => {
    assert.equal(decideTarget({ verdict: 'light' }, baseCfg, FLASH_MODEL), null)
  })
  test('decideTarget: heavy 在 Flash 上 → Pro', () => {
    assert.equal(decideTarget({ verdict: 'heavy' }, baseCfg, FLASH_MODEL), PRO_MODEL)
  })
  test('decideTarget: heavy 在 Pro 上 → 保持', () => {
    assert.equal(decideTarget({ verdict: 'heavy' }, baseCfg, PRO_MODEL), null)
  })
  test('decideTarget: short → Flash', () => {
    assert.equal(decideTarget({ verdict: 'short' }, baseCfg, PRO_MODEL), FLASH_MODEL)
  })
  test('decideTarget: unknown → 保持', () => {
    assert.equal(decideTarget({ verdict: 'unknown' }, baseCfg, PRO_MODEL), null)
  })
  test('decideTarget: unknown + unknownToFlash → Flash', () => {
    assert.equal(decideTarget({ verdict: 'unknown' }, { ...baseCfg, unknownToFlash: true }, PRO_MODEL), FLASH_MODEL)
  })
  test('decideTarget: 非 Pro/Flash 模型不路由', () => {
    assert.equal(decideTarget({ verdict: 'light' }, baseCfg, 'stealth/ox-alpha'), null)
  })

  // ── extractTaskText ──
  test('extractTaskText: 字符串与文本块混合', () => {
    const msgs = [
      { content: 'hello' },
      { content: [{ type: 'text', text: 'world' }, { type: 'image', image: 'x' }] },
    ]
    assert.equal(extractTaskText(msgs), 'hello\nworld')
  })

  // ── classifyReasoning（liangshen 词法打分）──
  test('classifyReasoning: "We need" 开局 → anchored', () => {
    assert.ok(classifyReasoning([{ type: 'reasoning', text: 'We need to plan this carefully' }]) >= 4)
  })
  test('classifyReasoning: "Let me" 开局 → 非 anchored', () => {
    assert.ok(classifyReasoning([{ type: 'reasoning', text: 'Let me check the files first' }]) < 4)
  })
  test('classifyReasoning: 混合 → 非 anchored', () => {
    assert.ok(classifyReasoning([{ type: 'reasoning', text: 'We should look, but let me verify' }]) < 4)
  })
  test('classifyReasoning: 非 reasoning 块忽略', () => {
    assert.equal(classifyReasoning([{ type: 'text', text: 'We need to plan' }]), 0)
  })
  test('classifyReasoning: your/hour 等假阳性不再贡献 our 分数（词边界回归）', () => {
    // 修复前无边界 our 会误命中 → 得分 2；修复后为 0
    assert.equal(classifyReasoning([{ type: 'reasoning', text: 'Within an hour' }]), 0)
    assert.equal(classifyReasoning([{ type: 'reasoning', text: 'Reviewing your proposal' }]), 0)
    assert.ok(classifyReasoning([{ type: 'reasoning', text: 'Reviewing our proposal' }]) >= 2)
  })

  // ── promotionState（request/header pro 强信号 → resume 防御；WeakMap 按 agent 对象键控）──
  const mkPromoShared = () => ({
    promotion: new WeakMap(), anchorGate: true, promoteAfterFirstResponse: true, proMaxBootstrapSteps: 4,
  })
  test('promotionState: request/header 出现过 pro → 直接 promoted', () => {
    const shared = mkPromoShared()
    const agent = { id: 'a1', session: { events: [
      { type: 'user/message', data: {} },
      { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } },
    ] } }
    assert.equal(promotionState(agent, shared).phase, 'promoted')
  })
  test('promotionState: 仅 flash header → 维持 bootstrap', () => {
    const shared = mkPromoShared()
    const agent = { id: 'a2', session: { events: [
      { type: 'user/message', data: {} },
      { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    ] } }
    assert.equal(promotionState(agent, shared).phase, 'bootstrap')
  })
  test('promotionState: 同一 agent 对象幂等（返回缓存实例），不同对象互不污染', () => {
    const shared = mkPromoShared()
    const a = { id: 'dup', session: { events: [] } }
    assert.equal(promotionState(a, shared), promotionState(a, shared))
    const b = { id: 'dup', session: { events: [{ type: 'tool/call', data: {} }] } } // 同 id 新对象 ≠ 陈旧状态
    assert.notEqual(promotionState(b, shared), promotionState(a, shared))
  })
  test('isFlashAnchored: 步数兜底晋升（锚定 N 步，第 N+1 步释放）', () => {
    const shared = mkPromoShared()
    const a = { id: 'f1', session: { events: [] } }
    shared.promotion.set(a, { phase: 'gate', steps: 3 })
    assert.equal(isFlashAnchored(a, shared, 2), false)
    const b = { id: 'f2', session: { events: [] } }
    shared.promotion.set(b, { phase: 'gate', steps: 2 })
    assert.equal(isFlashAnchored(b, shared, 2), true)
    const c = { id: 'f3', session: { events: [] } }
    assert.equal(isFlashAnchored(c, shared, 2), true)
  })
  test('flash 步数接线回归：pre-step 为 flash 建表计步，N+1 步释放工具锚定', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installBoost(ctx, () => baseCfg, shared)
    const agent = { id: 'f-wire', options: { model: FLASH_MODEL }, session: { events: [] } }
    const run = async () => { await ctx.handlers['agent/pre-step'][0]({ agent }, async () => ({ kind: 'enter', messages: [] })) }
    await run() // steps=1
    assert.equal(isFlashAnchored(agent, shared, 2), true)
    await run() // steps=2
    assert.equal(isFlashAnchored(agent, shared, 2), true)
    await run() // steps=3 → 3 > 2 释放
    assert.equal(isFlashAnchored(agent, shared, 2), false)
  })

  // ── Boost pre-step：phase-1 过滤仅锚定期生效（晋升门控回归）──
  test('boost 过滤：锚定期白名单外消息被剥离', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installBoost(ctx, () => baseCfg, shared)
    const agent = { id: 'p-boot', options: { model: PRO_MODEL }, session: { events: [] } }
    const messages = [
      { source: { kind: 'user' }, content: '任务' },
      { source: { kind: 'plugin', plugin: 'tmux-context' }, content: '注入' },
    ]
    const out = await ctx.handlers['agent/pre-step'][0]({ agent }, async () => ({ kind: 'enter', messages }))
    assert.equal(out.messages.length, 1)
    assert.equal(out.messages[0].source.kind, 'user')
  })
  test('boost 过滤：晋升后不过滤（workspace/skill-catalog 注入保留）', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installBoost(ctx, () => baseCfg, shared)
    const agent = { id: 'p-promo', options: { model: PRO_MODEL }, session: { events: [] } }
    shared.promotion.set(agent, { phase: 'promoted', toolCalled: true, responded: true, anchored: true, proSeen: true, steps: 9 })
    const messages = [
      { source: { kind: 'user' }, content: '任务' },
      { source: { kind: 'skill-catalog' }, content: '<available_skills>…</available_skills>' },
      { source: { kind: 'plugin', plugin: 'x' }, content: '上下文' },
    ]
    const out = await ctx.handlers['agent/pre-step'][0]({ agent }, async () => ({ kind: 'enter', messages }))
    assert.equal(out.messages.length, 3)
  })

  // ── effectiveModel：预算硬约束与降级换轨的组装侧对齐 ──
  test('effectiveModel: 预算超限强制 Flash（与 request 一致）', () => {
    const f = fixtureLedger('.tmp-em-budget.json', {
      days: { '2026-08-25': { sessions: [{ id: 'em-b', input: 500, output: 10 }] } },
    })
    // 直接验证共用的预算判定函数（effectiveModel 内部即消费它）
    assert.equal(sessionBudgetOver('em-b', { budgetCapTokens: 100 }, f), true)
    assert.equal(sessionBudgetOver('em-b', { budgetCapTokens: 10000 }, f), false)
    assert.equal(sessionBudgetOver('em-b', { budgetCapTokens: 0 }, f), false)
  })
  test('effectiveModel: 有待降级换轨时跟随另一模型；模式优先级最高', () => {
    const shared = mkShared()
    const cfg = { ...baseCfg }
    const agent = { id: 'em-fb', options: { model: PRO_MODEL } }
    assert.equal(effectiveModel(agent, PRO_MODEL, shared, cfg), PRO_MODEL)
    shared.fallbackPending.set('em-fb|7|3', 1)
    assert.equal(hasPendingFallback(agent, shared), true)
    assert.equal(effectiveModel(agent, PRO_MODEL, shared, cfg), FLASH_MODEL)
    shared.sessionModes.set(agent, 'pro-all')
    assert.equal(effectiveModel(agent, PRO_MODEL, shared, cfg), PRO_MODEL, '/route 显式模式优先于降级近似信号')
  })
  test('effectiveModel: 决策驱动的路由推导', () => {
    const shared = mkShared()
    const cfg = { ...baseCfg }
    const a = { id: 'em-d1', options: {} }
    shared.decision.set(a, { verdict: 'heavy', light: 0, heavy: 1, len: 20 })
    assert.equal(effectiveModel(a, FLASH_MODEL, shared, cfg), PRO_MODEL)
    const b = { id: 'em-d2', options: {} }
    shared.decision.set(b, { verdict: 'light', light: 1, heavy: 0, len: 20 })
    assert.equal(effectiveModel(b, PRO_MODEL, shared, cfg), FLASH_MODEL)
    const c = { id: 'em-d3', options: {} }
    assert.equal(effectiveModel(c, PRO_MODEL, shared, cfg), PRO_MODEL, '无决策保持初始模型')
  })

  // ── 失败降级：每 turn/step 至多一次 + 协作语义 + abort 防护（安装级回归）──
  const FB_CFG = () => ({ ...baseCfg, enabled: true, fallbackOnError: true })
  test('fallback: 首次失败打标并 retry；同一步第二次失败放行终态', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installRouter(ctx, FB_CFG, shared)
    const agent = { id: 'fb1', options: { subagentDepth: 1 } }
    const errPayload = (sig = { aborted: false }) => ({
      agent, turn: 0, step: 2, provider: 'deepseek-official', failure: { code: 'rate_limit_exceeded' }, signal: sig,
    })
    const act1 = await ctx.handlers['agent/request-error'][0](errPayload(), async () => undefined)
    assert.deepEqual(act1, { kind: 'retry' })
    const act2 = await ctx.handlers['agent/request-error'][0](errPayload(), async () => undefined)
    assert.ok(!act2?.kind, '同一步内不允许第二次降级重试（防双模型死循环）')
  })
  test('fallback: request 消费标记后真正换轨一次', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installRouter(ctx, FB_CFG, shared)
    const agent = { id: 'fb2', options: { subagentDepth: 1 } }
    await ctx.handlers['agent/request-error'][0](
      { agent, turn: 1, step: 0, provider: 'deepseek-official', failure: { code: 'server_error' }, signal: { aborted: false } },
      async () => undefined,
    )
    const reqHandler = ctx.handlers['agent/request'].find((fn) => fn.length === 2)
    const swapped = await reqHandler({ agent, turn: 1, step: 0 }, async () => ({ provider: 'deepseek-official', model: PRO_MODEL }))
    assert.equal(swapped.model, FLASH_MODEL)
    const again = await reqHandler({ agent, turn: 1, step: 0 }, async () => ({ provider: 'deepseek-official', model: PRO_MODEL }))
    assert.equal(again.model, PRO_MODEL, '标记一次性：此后不再改写')
  })
  test('fallback: 下游已有显式决策时尊重所有权，不覆盖', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installRouter(ctx, FB_CFG, shared)
    const agent = { id: 'fb3', options: { subagentDepth: 1 } }
    const upstream = { kind: 'giveup' }
    const out = await ctx.handlers['agent/request-error'][0](
      { agent, turn: 2, step: 5, provider: 'deepseek-official', failure: { code: 'overloaded' }, signal: { aborted: false } },
      async () => upstream,
    )
    assert.equal(out, upstream)
  })
  test('fallback: signal 已中止时不抢恢复权', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installRouter(ctx, FB_CFG, shared)
    const agent = { id: 'fb4', options: { subagentDepth: 1 } }
    const out = await ctx.handlers['agent/request-error'][0](
      { agent, turn: 3, step: 1, provider: 'deepseek-official', failure: { code: 'aborted' }, signal: { aborted: true } },
      async () => undefined,
    )
    assert.ok(!out?.kind)
    assert.equal(shared.fallbackMarks.size, 0)
  })
  test('fallback: 跨步残留惰性清理（新步骤重新武装）', async () => {
    const ctx = makeCtx()
    const shared = mkShared()
    installRouter(ctx, FB_CFG, shared)
    const agent = { id: 'fb5', options: { subagentDepth: 1 } }
    await ctx.handlers['agent/request-error'][0](
      { agent, turn: 9, step: 1, provider: 'deepseek-official', failure: { code: 'x' }, signal: { aborted: false } },
      async () => undefined,
    )
    assert.equal(shared.fallbackMarks.size, 1)
    await ctx.handlers['agent/request-error'][0](
      { agent, turn: 9, step: 2, provider: 'deepseek-official', failure: { code: 'x' }, signal: { aborted: false } },
      async () => undefined,
    )
    assert.equal([...shared.fallbackMarks.keys()].filter((k) => k.startsWith('fb5|')).length, 1, '旧步标记被清理，仅剩当前步')
  })

  // ── readSessionUsedTokens（fixture 注入 ledger 路径）──
  const tmpFiles = []
  const fixtureLedger = (name, obj) => {
    const f = path.join(TESTS_DIR, name)
    fs.writeFileSync(f, JSON.stringify(obj))
    tmpFiles.push(f)
    return f
  }
  test('readSessionUsedTokens: 跨天多条目全量累加（cacheRead 不计入）', () => {
    const f = fixtureLedger('.tmp-ledger-multi.json', {
      days: {
        '2026-08-24': { sessions: [{ id: 's-multi', input: 100, output: 20, reasoning: 5, cacheRead: 999999999 }] },
        '2026-08-25': { sessions: [{ id: 's-multi', input: 300, output: 40, reasoning: 10, cacheRead: 888888888 }] },
      },
    })
    assert.equal(readSessionUsedTokens('s-multi', f), 100 + 20 + 5 + 300 + 40 + 10)
  })
  test('readSessionUsedTokens: 会话无条目 → 0（不限制）', () => {
    const f = fixtureLedger('.tmp-ledger-none.json', {
      days: { '2026-08-25': { sessions: [{ id: 'other', input: 1, output: 1, reasoning: 1 }] } },
    })
    assert.equal(readSessionUsedTokens('s-ghost', f), 0)
  })
  test('readSessionUsedTokens: 账本不存在 → null（fail-open）', () => {
    assert.equal(readSessionUsedTokens('s-x', path.join(TESTS_DIR, '.tmp-ledger-missing.json')), null)
  })
  test('readSessionUsedTokens: 账本损坏（JSON 解析失败）→ null（fail-open）', () => {
    const f = path.join(TESTS_DIR, '.tmp-ledger-corrupt.json')
    fs.writeFileSync(f, '{ not valid json !!')
    tmpFiles.push(f)
    assert.equal(readSessionUsedTokens('s-x', f), null)
  })
  test('readSessionUsedTokens: 字段缺失按 0 计', () => {
    const f = fixtureLedger('.tmp-ledger-partial.json', {
      days: { '2026-08-25': { sessions: [{ id: 's-partial', input: 50 }, { id: 's-partial', output: 7 }] } },
    })
    assert.equal(readSessionUsedTokens('s-partial', f), 57)
  })

  for (const { name, fn } of cases) {
    try {
      await fn()
      pass += 1
      console.log(`  ✔ ${name}`)
    } catch (e) {
      fail += 1
      console.log(`  ✖ ${name}\n    ${e.message}`)
    }
  }
  // 清理 fixture
  for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail > 0 ? 1 : 0
}

run()
