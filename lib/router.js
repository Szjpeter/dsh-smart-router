// dsh-smart-router — 模块 A：智能路由
// 挂钩点：
//   agent/pre-step     → 提取任务文本、评估复杂度（每轮一次，缓存）
//   agent/request      → 按评估结果改写 provider/model（含预算上限：读 cost-meter 账本）
//   agent/request-error→ 失败时 Pro<->Flash 降级/升级重试
// 状态生命周期：晋升/决策/会话模式用 WeakMap 以活跃 agent 对象为键（对象销毁自动回收，
// 且天然免疫 id 复用串状态）；降级尝试表以 `${id}|${turn}|${step}` 为键并做容量裁剪。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { keywordScore, evaluateComplexity } from './keywords.js'
import { isPeakHour } from './settings.js'

export const PRO_MODEL = 'deepseek-v4-pro'
export const FLASH_MODEL = 'deepseek-v4-flash'

const OFFICIAL_PROVIDER = 'deepseek-official'

/** 当前模型是否属于 Pro/Flash 路由域 */
export function isRouteableModel(model) {
  return model === PRO_MODEL || model === FLASH_MODEL
}

/** 从 agent 对象判断是否子代理（subagentDepth 由 dsh-subagent 注入 options） */
export function isSubagent(agent) {
  return Number.isSafeInteger(agent?.options?.subagentDepth) && agent.options.subagentDepth > 0
}

/** 从 claimed messages 提取任务全文 */
export function extractTaskText(messages) {
  const parts = []
  for (const m of messages ?? []) {
    const c = m?.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text)
      }
    }
  }
  return parts.join('\n').trim()
}

/** 提取用户任务文本（只取 user/goal 源消息，排除注入/指令消息） */
export function extractUserTaskText(messages) {
  const userMsgs = (messages ?? []).filter((m) => {
    const kind = m?.source?.kind
    return kind === 'user' || kind === 'goal'
  })
  return extractTaskText(userMsgs)
}

/**
 * 决策：给定评估结果与配置，返回目标模型（'pro' | 'flash' | null=保持）
 * 借鉴 dsh-delegate-router 的 trigger 语义：auto-light / auto-heavy / auto-short / peak / budget / unknown
 */
export function decideTarget(ev, cfg, currentModel) {
  if (!isRouteableModel(currentModel)) return null
  const nowPro = currentModel === PRO_MODEL

  switch (ev?.verdict) {
    case 'light':
    case 'short':
      return nowPro ? FLASH_MODEL : null // 已是 Flash 则保持
    case 'heavy':
      return nowPro ? null : PRO_MODEL // 已是 Pro 则保持
    case 'unknown':
    default:
      // 峰谷降级（北京时间高峰、未知任务 → Flash）
      if (cfg.peakDemoteUnknown && isPeakHour(cfg.peakHours)) return nowPro ? FLASH_MODEL : null
      // 激进策略：未知 → Flash
      if (cfg.unknownToFlash) return nowPro ? FLASH_MODEL : null
      return null // 保持原模型
  }
}

// ── 预算跟踪（读 dsh-cost-meter 账本；fail-open）──
// 账本结构：{ days: { 'YYYY-MM-DD': { sessions: [{ id, input, output, cacheRead, reasoning, ... }] } } }
// 同一会话跨天会出现多条，需按 id 全量聚合；cacheRead 是缓存命中（数值上亿），必须排除。
// 注：dsh-agent-loop 中 agent 与其 session 共享同一调用方身份（create(id) 的共享身份），
// 因此 agent.id 即账本里的 session id。
const LEDGER_PATH = path.join(os.homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json')

let budgetCache = { at: 0, id: null, file: null, used: null }

/** 聚合当前会话累计 token（input+output+reasoning，排除 cacheRead）。不可读/无条目 → null/0，均不限制。 */
export function readSessionUsedTokens(sessionId, ledgerFile = LEDGER_PATH) {
  // TTL 缓存 10s：ledger 可能较大且每次 request 都会查询
  if (Date.now() - budgetCache.at < 10_000 && budgetCache.id === sessionId && budgetCache.file === ledgerFile) {
    return budgetCache.used
  }
  try {
    const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    let used = 0
    for (const day of Object.values(data.days ?? {})) {
      for (const s of day.sessions ?? []) {
        if (s.id === sessionId) used += (s.input ?? 0) + (s.output ?? 0) + (s.reasoning ?? 0)
      }
    }
    budgetCache = { at: Date.now(), id: sessionId, file: ledgerFile, used }
    return used
  } catch {
    return null // cost-meter 未装/文件写入中/解析失败 → 不限制（fail-open）
  }
}

/** 预算硬约束判定：超限返回 true（供 agent/request 与 boost 的 effectiveModel 共用，保证两边一致）
 *  ledgerFile 可选覆盖（cfg.ledgerFile 或显式参数；测试/高级场景用），默认读 cost-meter 账本 */
export function sessionBudgetOver(sessionId, cfg, ledgerFile) {
  if (!(cfg?.budgetCapTokens > 0)) return false
  const used = readSessionUsedTokens(sessionId, ledgerFile ?? cfg?.ledgerFile ?? LEDGER_PATH)
  return used !== null && used > cfg.budgetCapTokens
}

// ── 失败降级尝试表（每 turn/step 至多一次切换；防双模型死循环）──
// 键：`${agent.id}|${turn}|${step}`；值恒为 1。
//  - fallbackMarks：该步已触发过一次降级标记（防同一步内反复打标重试）
//  - fallbackPending：待下一次 agent/request 消费并真正换轨
const FALLBACK_SOFT_CAP = 96

function fallbackKey(agent, turn, step) {
  return `${agent?.id ?? '?'}|${turn}|${step}`
}

function pruneFallbackMaps(shared) {
  for (const map of [shared.fallbackMarks, shared.fallbackPending]) {
    if (map.size > FALLBACK_SOFT_CAP) {
      for (const k of map.keys()) {
        map.delete(k)
        if (map.size <= FALLBACK_SOFT_CAP / 2) break
      }
    }
  }
}

/** 清掉同 agent 过期步骤的残留标记（换 turn/step 时惰性清理） */
function purgeStaleFallback(shared, agent, turn, step) {
  const prefix = `${agent?.id ?? '?'}|`
  const cur = fallbackKey(agent, turn, step)
  for (const map of [shared.fallbackMarks, shared.fallbackPending]) {
    for (const k of [...map.keys()]) {
      if (k.startsWith(prefix) && k !== cur) map.delete(k)
    }
  }
}

/** 该 agent 是否有待消费的降级换轨（前缀匹配；boost 组装侧与 request 换轨保持一致的近似信号） */
export function hasPendingFallback(agent, shared) {
  if (!agent?.id) return false
  const prefix = `${agent.id}|`
  for (const k of shared.fallbackPending.keys()) {
    if (k.startsWith(prefix)) return true
  }
  return false
}

/** 安装路由模块 */
export function installRouter(ctx, getConfig, shared) {
  // 每轮评估结果缓存（与 boost 共享）：WeakMap<Agent, {verdict, light, heavy, len}>
  const decisionCache = shared.decision
  // 会话级路由模式：WeakMap<Agent, 'auto'|'off'|'flash-all'|'pro-all'>
  const sessionModes = shared.sessionModes

  // ── /route 命令（会话级模式切换）──
  try {
    ctx.commands.register({
      name: 'route',
      description: '智能路由模式：auto | off | flash-all | pro-all',
      handler: (invocation) => {
        const mode = (invocation.rawInput ?? '').trim() || 'auto'
        if (!['auto', 'off', 'flash-all', 'pro-all'].includes(mode)) {
          return { kind: 'error', text: `smart-router: 未知模式 "${mode}"，可用 auto | off | flash-all | pro-all` }
        }
        if (invocation.agent) sessionModes.set(invocation.agent, mode)
        return { kind: 'success', text: `smart-router: 本会话路由模式已设为 ${mode}` }
      },
    })
  } catch (e) {
    ctx.logger.warn(`[smart-router] /route command register failed: ${e?.message ?? e}`)
  }

  // ── agent/inbox/inserted：消息入队即评估复杂度（早于 assemble，供增强模块使用）──
  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const cfg = getConfig()
      const agent = payload?.agent
      if (!cfg.enabled || !agent) return
      const sub = isSubagent(agent)
      if (sub ? !cfg.routeSubagents : !cfg.routeMainSession) return
      const text = extractUserTaskText([payload?.message])
      if (!text) return
      const ev = evaluateComplexity(text, cfg)
      decisionCache.set(agent, ev)
      ctx.logger.debug(`[smart-router] eval(inserted) agent=${String(agent.id).slice(0, 12)} verdict=${ev.verdict} light=${ev.light} heavy=${ev.heavy} len=${ev.len}`)
    } catch (e) {
      ctx.logger.warn(`[smart-router] inserted eval failed: ${e?.message ?? e}`)
    }
  })

  // ── system-prompt/assemble：在 next() 之前评估（早于 boost 内层；任务文本来自 agent.inbox）──
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    try {
      const cfg = getConfig()
      const agent = context?.agent
      if (!cfg.enabled || !agent) return next()
      const sub = isSubagent(agent)
      if (sub ? !cfg.routeSubagents : !cfg.routeMainSession) return next()
      // 从 inbox 的 pending 消息提取任务文本（assemble 时任务消息尚未 append 到 session）
      const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]
      const text = extractUserTaskText(pending)
      if (!text) return next()
      const ev = evaluateComplexity(text, cfg)
      decisionCache.set(agent, ev)
      ctx.logger.debug(`[smart-router] eval(assemble) agent=${String(agent.id).slice(0, 12)} verdict=${ev.verdict} light=${ev.light} heavy=${ev.heavy} len=${ev.len}`)
    } catch (e) {
      ctx.logger.warn(`[smart-router] assemble eval failed: ${e?.message ?? e}`)
    }
    return next()
  })

  // ── agent/pre-step：兜底评估（覆盖 assemble，供 request 路由使用）──
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const cfg = getConfig()
      const agent = payload.agent
      if (!cfg.enabled || !agent) return decision
      purgeStaleFallback(shared, agent, payload.turn, payload.step)
      const sub = isSubagent(agent)
      if (sub ? !cfg.routeSubagents : !cfg.routeMainSession) return decision
      const text = extractUserTaskText(payload.messages)
      if (!text) return decision
      const ev = evaluateComplexity(text, cfg)
      decisionCache.set(agent, ev)
      ctx.logger.debug(`[smart-router] eval agent=${String(agent.id).slice(0, 12)} verdict=${ev.verdict} light=${ev.light} heavy=${ev.heavy} len=${ev.len}`)
    } catch (e) {
      ctx.logger.warn(`[smart-router] pre-step eval failed: ${e?.message ?? e}`)
    }
    return decision
  })

  // ── agent/request：路由执行 ──
  ctx.on('agent/request', async (payload, next) => {
    const proposal = await next()
    try {
      const cfg = getConfig()
      const agent = payload.agent
      if (!cfg.enabled || !agent) return proposal
      if (!isRouteableModel(proposal.model)) return proposal

      // 会话级模式优先（/route 显式命令，不受路由范围限制）
      const mode = sessionModes.get(agent)
      if (mode === 'off') return proposal
      if (mode === 'flash-all') return proposal.model === FLASH_MODEL ? proposal : { ...proposal, model: FLASH_MODEL }
      if (mode === 'pro-all') return proposal.model === PRO_MODEL ? proposal : { ...proposal, model: PRO_MODEL }

      // 失败降级消费（request-error 打标后，本步至多换轨一次）
      const fk = fallbackKey(agent, payload.turn, payload.step)
      if (shared.fallbackPending.delete(fk)) {
        const alt = proposal.model === PRO_MODEL ? FLASH_MODEL : PRO_MODEL
        ctx.logger.warn(`[smart-router] fallback route ${proposal.model} -> ${alt}`)
        if (cfg.ledgerEnabled) recordLedger(ctx, agent, { route: alt, trigger: 'fallback' })
        return { ...proposal, model: alt }
      }

      // 预算上限：超限一律 Flash（依赖 cost-meter 账本；账本不可读不限制 = fail-open）
      // 放在路由范围判断之前：预算是硬约束，主会话关路由时同样生效
      if (sessionBudgetOver(agent.id, cfg)) {
        const used = readSessionUsedTokens(agent.id)
        ctx.logger.warn(`[smart-router] budget exceeded (${used} > ${cfg.budgetCapTokens}); route to Flash`)
        if (cfg.ledgerEnabled && proposal.model !== FLASH_MODEL) recordLedger(ctx, agent, { route: FLASH_MODEL, trigger: 'budget' })
        return proposal.model === FLASH_MODEL ? proposal : { ...proposal, model: FLASH_MODEL }
      }

      // 路由范围（主会话默认关 / 子代理默认开）
      const sub = isSubagent(agent)
      if (sub ? !cfg.routeSubagents : !cfg.routeMainSession) return proposal

      // 只在本轮评估结果内路由（缓存 miss 时保持）
      const cached = decisionCache.get(agent)
      const target = cached ? decideTarget(cached, cfg, proposal.model) : null
      if (target && target !== proposal.model) {
        ctx.logger.info(`[smart-router] route ${proposal.model} -> ${target} (${cached.verdict}) agent=${String(agent.id).slice(0, 12)}`)
        if (cfg.ledgerEnabled) recordLedger(ctx, agent, { route: target, trigger: cached.verdict, light: cached.light, heavy: cached.heavy, len: cached.len })
        return { ...proposal, model: target }
      }
    } catch (e) {
      ctx.logger.warn(`[smart-router] route failed: ${e?.message ?? e}`)
    }
    return proposal
  })

  // ── agent/request-error：失败降级/升级重试（每 turn/step 至多一次）──
  // 协作语义：下游已给出任何显式决策（含非 retry）都尊重其所有权；
  // 仅当无人接管、信号未中止、目标提供方匹配时，才打标（下一次请求换轨）并返回 retry。
  ctx.on('agent/request-error', async (payload, next) => {
    const action = await next()
    try {
      const cfg = getConfig()
      const agent = payload.agent
      if (action?.kind) return action // 已有恢复方接管（尊重任何显式 kind）
      if (!cfg.enabled || !cfg.fallbackOnError || !agent) return action
      if (payload.signal?.aborted) return action // 取消/中止不抢恢复权
      if (payload.provider !== OFFICIAL_PROVIDER) return action
      const fk = fallbackKey(agent, payload.turn, payload.step)
      if (shared.fallbackMarks.has(fk)) return action // 本步已用过唯一一次降级机会
      shared.fallbackMarks.set(fk, 1)
      purgeStaleFallback(shared, agent, payload.turn, payload.step)
      pruneFallbackMaps(shared)
      ctx.logger.warn(`[smart-router] request-error (${payload.failure?.code}) on ${payload.provider}; switching model and retrying`)
      shared.fallbackPending.set(fk, 1)
      return { kind: 'retry' }
    } catch (e) {
      ctx.logger.warn(`[smart-router] fallback failed: ${e?.message ?? e}`)
    }
    return action
  })
}

// ── 账本 ──
function recordLedger(ctx, agent, entry) {
  try {
    agent.session?.append?.('smart-router/ledger', { ...entry, at: Date.now() })
  } catch {
    // 账本写入失败不影响路由
  }
}
