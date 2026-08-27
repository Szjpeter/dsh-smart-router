// dsh-smart-router — 宿主循环模拟集成测试
// 不启动真实 Harness，用宿主桩把插件完整行为链跑通：
//   inbox/inserted → pre-step → system-prompt/assemble → agent/request
// 覆盖：Flash persona/guide 注入、工具锚定与释放、Pro 路由升级、主会话范围、
//       预算强制 Flash 的组装一致性、/route 命令、账本记录。
// 运行：node tests/integration.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRouter, PRO_MODEL, FLASH_MODEL } from '../lib/router.js'
import {
  installBoost, FLASH_PERSONA, GUIDE_DEEP, GUIDE_FAST, MINIMAL_PERSONA,
} from '../lib/boost.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ── 宿主桩 ──
function makeCtx() {
  const handlers = {}
  const commands = []
  return {
    handlers,
    commands,
    on(name, fn) { (handlers[name] ??= []).push(fn) },
    logger: { info() {}, warn() {}, debug() {} },
    commands: { register: (c) => commands.push(c), list: commands },
  }
}

// 本机 DSH 风格工具集（不含 bash/str_replace_editor，验证多生态默认值匹配）
const TOOL_NAMES = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'read_image', 'skill']
const ALL_TOOLS = TOOL_NAMES.map((name) => ({ name }))

function makeAgent(id, opts = {}) {
  const events = []
  let seq = 0
  const session = {
    id,
    events,
    append(type, data) { events.push({ type, data }); return { seq: ++seq } },
  }
  const options = { model: opts.model }
  if (opts.subagentDepth !== undefined) options.subagentDepth = opts.subagentDepth
  return { id, options, session, inbox: { nextTurn: [], nextStep: [] } }
}

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

const CFG = {
  enabled: true,
  routeMainSession: false,
  routeSubagents: true,
  lightKeywords: ['搜索', '查询', '翻译', '总结', 'search', 'list', 'quick'],
  heavyKeywords: ['重构', '架构', '设计', '调试', '优化', 'refactor', 'architecture', 'debug'],
  shortTaskMaxChars: 60,
  unknownToFlash: false,
  peakDemoteUnknown: false,
  peakHours: [[9, 12], [14, 18]],
  budgetCapTokens: 0,
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
  ledgerEnabled: true,
}

// waterfall 链式调用（与 cordis 一致的协作语义：各监听器按注册序，next() 透传下游）
async function runEvent(handlers, name, payload, seed) {
  const list = handlers[name] ?? []
  let i = 0
  const next = async () => (i >= list.length ? seed : await list[i++](payload, next))
  return await next()
}

// assemble 的签名是 (assembly, context, next)，单独处理
async function runAssemble(handlers, assembly, context) {
  const list = handlers['system-prompt/assemble'] ?? []
  let i = 0
  const next = async () => (i >= list.length ? assembly : await list[i++](assembly, context, next))
  return await next()
}

// 模拟一轮：消息入队 → pre-step → assemble → request
async function runStep(ctx, agent, userText, turn, stepNo) {
  const msg = { source: { kind: 'user' }, content: userText }
  agent.inbox.nextTurn = [msg]
  agent.inbox.nextStep = []
  await runEvent(ctx.handlers, 'agent/inbox/inserted', { agent, message: msg }, undefined)
  const decision = await runEvent(ctx.handlers, 'agent/pre-step', { agent, messages: [msg], turn, step: stepNo }, { kind: 'enter', messages: [msg] })
  const assembly = {
    sections: [{ name: 'deployment:persona', text: 'base persona' }],
    tools: ALL_TOOLS.map((t) => ({ ...t })),
    contexts: [{ source: { kind: 'plugin', plugin: 'x' }, content: 'runtime ctx' }],
  }
  const assembled = await runAssemble(ctx.handlers, assembly, { agent })
  const proposed = await runEvent(ctx.handlers, 'agent/request', { agent, turn, step: stepNo }, { provider: 'deepseek-official', model: agent.options.model })
  return { decision, assembled, proposed }
}

const sectionText = (a, name) => a.sections.find((s) => s.name === name)?.text
const ledgerOf = (agent) => agent.session.events.filter((e) => e.type === 'smart-router/ledger').map((e) => e.data)

// ── 场景 1：ds-flash 子代理 + 轻任务 → 保持 flash，Flash 满血注入 ──
test('flash 子代理轻任务：persona+guide(FAST)+工具收窄+上下文清空，账本不动', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('f-light', { model: FLASH_MODEL, subagentDepth: 1 })

  const { assembled, proposed } = await runStep(ctx, agent, '请帮我搜索并总结一下今天的热点', 1, 0)

  assert.equal(proposed.model, FLASH_MODEL, 'light 已在 flash 上 → 保持')
  assert.equal(sectionText(assembled, 'deployment:persona'), FLASH_PERSONA, 'Flash persona 注入')
  assert.equal(sectionText(assembled, 'smart-router:guide'), GUIDE_FAST, 'light → GUIDE_FAST')
  assert.deepEqual(assembled.tools.map((t) => t.name), ['read', 'write', 'edit'], '锚定期工具收窄（多生态默认匹配 DSH 工具）')
  assert.deepEqual(assembled.contexts, [], '锚定期清空运行时上下文')
  assert.equal(ledgerOf(agent).length, 0, '未发生模型变更 → 无账本')
})

// ── 场景 2：ds-flash 子代理 + 重任务 → 升级 Pro，组装侧同步锚定 Pro ──
test('flash 子代理重任务：路由升级 Pro + 账本(heavy) + 组装侧 Pro phase-1 一致', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('f-heavy', { model: FLASH_MODEL, subagentDepth: 1 })

  const { assembled, proposed } = await runStep(ctx, agent, '请重构这个模块的架构，全面分析现有实现缺陷并修复', 1, 0)

  assert.equal(proposed.model, PRO_MODEL, 'heavy → 升级 Pro')
  assert.equal(sectionText(assembled, 'deployment:persona'), MINIMAL_PERSONA, '组装侧同步走 Pro phase-1 minimal persona')
  assert.deepEqual(assembled.tools.map((t) => t.name), ['pwsh', 'edit'], 'Pro 锚定工具（本机生态命中 pwsh/edit）')
  const ledger = ledgerOf(agent)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].route, PRO_MODEL)
  assert.equal(ledger[0].trigger, 'heavy')
})

// ── 场景 3：主会话（routeMainSession=false）→ 不路由不改写，但 Flash 满血仍生效 ──
test('主会话范围关闭：模型不改写，Flash persona 仍按 options.model 注入', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('main1', { model: FLASH_MODEL }) // 无 subagentDepth = 主会话

  const { assembled, proposed } = await runStep(ctx, agent, '请设计一个事件驱动架构并重构现有代码', 1, 0)

  assert.equal(proposed.model, FLASH_MODEL, '主会话不参与路由 → 模型保持')
  assert.equal(ledgerOf(agent).length, 0)
  assert.equal(sectionText(assembled, 'deployment:persona'), FLASH_PERSONA, 'Flash 增强与路由范围解耦，仍生效')
  assert.equal(sectionText(assembled, 'smart-router:guide'), GUIDE_FAST, '无路由决策 → 快速指导（用户关闭路由即期望轻量）')
})

// ── 场景 4：预算超限 → request 强制 Flash；组装侧 effectiveModel 同步（M1 一致性回归）──
test('预算超限：Pro 被强转 Flash，组装侧同步注入 Flash persona（不再错配）', async () => {
  const ledgerFile = path.join(os.tmpdir(), `sr-budget-${Date.now()}.json`)
  fs.writeFileSync(ledgerFile, JSON.stringify({
    days: { '2026-08-25': { sessions: [{ id: 'p-budget', input: 500, output: 10, reasoning: 0 }] } },
  }))
  const cfg = { ...CFG, budgetCapTokens: 100, ledgerFile }
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => cfg, shared)
  installBoost(ctx, () => cfg, shared)
  const agent = makeAgent('p-budget', { model: PRO_MODEL, subagentDepth: 1 })

  const { assembled, proposed } = await runStep(ctx, agent, '请实现一个分布式系统的性能优化方案', 1, 0)

  assert.equal(proposed.model, FLASH_MODEL, '预算硬约束 → 强制 Flash')
  const ledger = ledgerOf(agent)
  assert.equal(ledger.some((e) => e.trigger === 'budget'), true)
  assert.equal(sectionText(assembled, 'deployment:persona'), FLASH_PERSONA, '组装侧跟随预算走 Flash（M1 回归：不再给 Flash 注入 Pro 锚定）')
  fs.rmSync(ledgerFile, { force: true })
})

// ── 场景 5：Flash 锚定按步释放（N+1 步起全量目录，persona/guide 保留）──
test('flash 锚定 2 步后释放工具目录，persona/guide 持续保留', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('f-release', { model: FLASH_MODEL, subagentDepth: 1 })

  const s1 = await runStep(ctx, agent, '翻译这句话', 1, 0)
  const s2 = await runStep(ctx, agent, '再翻译一句', 1, 1)
  const s3 = await runStep(ctx, agent, '继续翻译', 1, 2)

  assert.deepEqual(s1.assembled.tools.map((t) => t.name), ['read', 'write', 'edit'], '第 1 步锚定')
  assert.deepEqual(s2.assembled.tools.map((t) => t.name), ['read', 'write', 'edit'], '第 2 步锚定')
  assert.equal(s3.assembled.tools.length, TOOL_NAMES.length, '第 3 步（steps=3 > 2）释放全量目录')
  assert.equal(sectionText(s3.assembled, 'deployment:persona'), FLASH_PERSONA, 'persona 持续')
  assert.equal(sectionText(s3.assembled, 'smart-router:guide'), GUIDE_FAST, 'guide 持续')
})

// ── 场景 6：/route flash-all 显式命令优先，组装侧同步 ──
test('/route flash-all：显式模式优先于一切，Pro agent 被钉在 Flash 且组装侧同步', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('p-pinned', { model: PRO_MODEL, subagentDepth: 1 })

  const cmd = ctx.commands.list.find((c) => c.name === 'route')
  assert.ok(cmd, '/route 命令已注册')
  assert.equal(cmd.handler({ rawInput: 'flash-all', agent }).kind, 'success')

  const { assembled, proposed } = await runStep(ctx, agent, '请设计并实现一个完整的微服务网关', 1, 0)
  assert.equal(proposed.model, FLASH_MODEL, 'flash-all 钉住 Flash')
  assert.equal(sectionText(assembled, 'deployment:persona'), FLASH_PERSONA, '组装侧跟随模式')
  assert.equal(ledgerOf(agent).length, 0, '显式模式不写账本（非自动路由决策）')
})

// ── 场景 7：失败降级全循环（P5）——error → 换轨 → 账本 → 同一步第二次失败终态 ──
test('失败降级全循环：error 打标 → request 换轨 Pro + 账本(fallback) → 同一步再次失败放行终态', async () => {
  const ctx = makeCtx()
  const shared = mkShared()
  installRouter(ctx, () => CFG, shared)
  installBoost(ctx, () => CFG, shared)
  const agent = makeAgent('fb-loop', { model: FLASH_MODEL, subagentDepth: 1 })

  const fireError = (turn, step) =>
    ctx.handlers['agent/request-error'][0](
      { agent, turn, step, provider: 'deepseek-official', failure: { code: 'overloaded' }, signal: { aborted: false } },
      async () => undefined,
    )
  const propose = (turn, step, model) =>
    ctx.handlers['agent/request'][0](
      { agent, turn, step },
      async () => ({ provider: 'deepseek-official', model }),
    )

  // 1) 首次失败 → 打标并 retry
  const a1 = await fireError(1, 4)
  assert.deepEqual(a1, { kind: 'retry' }, '首次失败返回 retry')
  assert.equal(hasPendingFallbackFlag(shared), true, '存在待消费换轨标记')

  // 2) 重试请求消费标记 → 换轨到 Pro，账本记录 trigger=fallback
  const swapped = await propose(1, 4, FLASH_MODEL)
  assert.equal(swapped.model, PRO_MODEL, '重试请求换轨到另一模型')
  const ledger = ledgerOf(agent)
  assert.equal(ledger.some((e) => e.trigger === 'fallback' && e.route === PRO_MODEL), true, '账本记录 fallback 换轨')

  // 3) 换轨后仍失败 → 同一步不再降级（防 Pro↔Flash 死循环，放行终态）
  const a2 = await fireError(1, 4)
  assert.ok(!a2?.kind, '同一步第二次失败不返回 retry（有界）')
  assert.equal(hasPendingFallbackFlag(shared), false, '标记已消费，无残留')
})

function hasPendingFallbackFlag(shared) {
  return shared.fallbackPending.size > 0
}

let pass = 0
let fail = 0
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
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail > 0 ? 1 : 0
