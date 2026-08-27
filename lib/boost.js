// dsh-smart-router — 模块 B：双模型满血增强
// 挂钩点：system-prompt/assemble（persona/工具锚定）+ agent/pre-step（phase-1 消息过滤 + 晋升统计）
//   Flash：w7 风格 persona（build/fix 分类 + 回顾锚）+ 首轮工具锚定 + 复杂度思考指导
//   Pro  ：liangshen 两阶段锚定——phase-1 minimal persona + 锚定工具 + 白名单消息（仅锚定期）
//          晋升双条件（anchorGate：tool/call + minimal-like reasoning）+ waitForCompleteReply
//          （无工具首轮等完整回复后晋升）+ 锚定幂等（持久推导 + sticky）+ 无工具兜底
//          （步数超限强制晋升 / 锚定工具不可用放行全量）
// 安全回退：任何异常返回原 assembly，绝不阻断请求
import { PRO_MODEL, FLASH_MODEL, isRouteableModel, sessionBudgetOver, hasPendingFallback } from './router.js'
import { isPeakHour } from './settings.js'

// Pro 锚定 persona —— 逐字节一致（官方 Minimal 46 字符句）
export const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.'

// Flash w7 风格 persona（借鉴 dsh-router-standard weak v7 + router-flash）
export const FLASH_PERSONA = `You are a helpful assistant.
Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.
Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps.
Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.
Produce when your information is complete, and end each reasoning block with a decision or an information need.`

// 复杂度分发的思考指导（借鉴 dsh-flash-godmode GUIDE_DEEP / GUIDE_FAST）
export const GUIDE_DEEP = `classify now: this task is complex. Think deeply about the architecture, edge cases, and integration points before writing. Do not spend reasoning on the environment or tooling. Produce when your information is complete, and end each reasoning block with a decision or an information need.`
export const GUIDE_FAST = `classify now: this task is simple. Think deeply first, then commit and act.`

const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona'])

/**
 * reasoning 块 minimal-like 打分（借鉴 liangshen classifyReasoning，阈值 >=4）：
 *   首行 "we need" +3；首行 "let me" -3；全块含 we/our +2；含 let me -2
 * （we/our 均带词边界，避免 your/hour/power 等尾缀误命中）
 */
export function classifyReasoning(content) {
  let score = 0
  const blocks = Array.isArray(content) ? content : [content]
  for (const b of blocks) {
    if (b?.type !== 'reasoning') continue
    const text = typeof b.text === 'string' ? b.text : ''
    const lower = text.toLowerCase()
    const firstLine = lower.split('\n')[0].trim()
    if (/^we need|^we will|^we're going to/i.test(firstLine)) score += 3
    else if (/^let me|^let's|^lets\b/i.test(firstLine)) score -= 3
    if (/\bwe\b|\bour\b|we'll/i.test(lower)) score += 2
    if (/let me|let's|lets\b/i.test(lower)) score -= 2
  }
  return score
}

export function hasAnchoredReasoning(content) {
  return classifyReasoning(content) >= 4
}

/**
 * Pro 晋升状态机（锚定幂等 + 晋升双条件 + waitForCompleteReply + 无工具兜底）。
 * 状态从持久 session events 重建（resume/reload/压缩不丢失、不重锚定）；
 * 以活跃 agent 对象为键存入 shared.promotion（WeakMap），对象销毁状态随之回收。
 */
export function promotionState(agent, shared) {
  const mem = agent ? shared.promotion.get(agent) : undefined
  if (mem) return mem // 幂等：内存态优先（已晋升不重扫）

  const st = {
    phase: 'bootstrap',     // bootstrap → gate(tool/call 已见) → promoted
    toolCalled: false,
    responded: false,       // waitForCompleteReply：完整 assistant 回复
    anchored: false,        // minimal-like reasoning 块已见（anchorGate 双条件之一）
    proSeen: false,         // request/header 出现过 deepseek-v4-pro（resume/compaction 后强信号）
    steps: 0,
  }
  for (const ev of agent?.session?.events ?? []) {
    if (ev.type === 'tool/call') {
      st.toolCalled = true
      if (st.phase === 'bootstrap') st.phase = 'gate'
    } else if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content
      const hasText = Array.isArray(content)
        ? content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
        : typeof content === 'string' && content.length > 0
      if (hasText && ev.data?.interrupted !== true) st.responded = true
      if (hasAnchoredReasoning(content)) st.anchored = true
    } else if (ev.type === 'request/header') {
      // 重启(resume) + compaction 剪除早期信号事件后，模型头是唯一可信的“早已度过锚定期”证据
      if (ev.data?.header?.config?.model === PRO_MODEL) st.proSeen = true
    }
  }
  // 晋升判定：decidePromotion 三分支 OR（借鉴 liangshen）；proSeen 短路优先（resume 防御）
  // steps 从 pre-step 计起（第 N 步时 steps=N），故步数兜底用 >（第 N+1 步晋升 = 锚定 N 步）
  if (st.proSeen) st.phase = 'promoted'
  else if (st.toolCalled && !shared.anchorGate) st.phase = 'promoted'
  else if (st.toolCalled && shared.anchorGate && (st.anchored || st.steps > shared.proMaxBootstrapSteps)) st.phase = 'promoted'
  else if (!st.toolCalled && st.responded && shared.promoteAfterFirstResponse) st.phase = 'promoted'
  if (agent) shared.promotion.set(agent, st)
  return st
}

/** Pro：是否应保持 phase-1 锚定 */
export function isProAnchored(agent, shared) {
  return promotionState(agent, shared).phase !== 'promoted'
}

/** Flash：首轮工具锚定（轻量，N 步兜底）——st 在 pre-step 已为所有模型建表计步 */
export function isFlashAnchored(agent, shared, maxSteps) {
  const st = shared.promotion.get(agent)
  if (st?.phase === 'promoted') return false
  if ((st?.steps ?? 0) > maxSteps) return false // 锚定 N 步后释放（第 N+1 步起全量目录）
  return true
}

/** 过滤工具集到锚定集（无工具兜底：锚定工具一个都不可用时，放行全部，不剥离） */
function anchorTools(assembly, anchorNames) {
  const all = assembly.tools ?? []
  if (all.length === 0) return all
  const matched = all.filter((t) => anchorNames.includes(t.name))
  if (matched.length === 0) return all // 无工具兜底
  return matched
}

/** 替换 persona section 文本（找不到则追加一条） */
function setPersona(assembly, text) {
  const sections = [...(assembly.sections ?? [])]
  const idx = sections.findIndex((s) => PERSONA_SECTION_NAMES.has(s.name))
  if (idx >= 0) sections[idx] = { ...sections[idx], text }
  else sections.push({ name: 'deployment:persona', text })
  return sections
}

/** phase-1 消息过滤：只放行白名单 source kind（借鉴 liangshen messageSources；仅锚定期生效） */
function filterMessages(messages, allowedSources) {
  return (messages ?? []).filter((m) => {
    const kind = m?.source?.kind
    return kind !== undefined && allowedSources.has(kind)
  })
}

/**
 * 决定"本请求实际将使用的模型"（assemble 在 agent/request 之前执行，不能读请求模型；
 * 用 pre-step 已写入的路由决策 + /route 会话模式 + 预算硬约束 + 待降级换轨推导，
 * 与 agent/request 的改写保持一致，避免锚定注入到未路由的模型上）。
 */
export function effectiveModel(agent, optionsModel, shared, cfg) {
  // /route 显式模式优先
  const mode = shared.sessionModes.get(agent)
  if (mode === 'flash-all') return FLASH_MODEL
  if (mode === 'pro-all') return PRO_MODEL
  // 预算硬约束（与 agent/request 的预算分支一致：超限一律 Flash）
  if (sessionBudgetOver(agent?.id, cfg)) return FLASH_MODEL
  // 失败降级待消费：下一个请求将切到另一模型（组装侧同步跟随）
  if (isRouteableModel(optionsModel) && hasPendingFallback(agent, shared)) {
    return optionsModel === PRO_MODEL ? FLASH_MODEL : PRO_MODEL
  }
  // 自动路由决策（pre-step 评估）
  const dec = shared.decision.get(agent)
  if (dec) {
    if (dec.verdict === 'heavy') return PRO_MODEL
    if (dec.verdict === 'light' || dec.verdict === 'short') return FLASH_MODEL
    // unknown：峰谷降级 / 激进策略
    if (cfg.unknownToFlash) return FLASH_MODEL
    if (cfg.peakDemoteUnknown && isPeakHour(cfg.peakHours)) return FLASH_MODEL
  }
  return optionsModel // 保持初始模型
}

/** 安装满血增强模块 */
export function installBoost(ctx, getConfig, shared) {
  // ── agent/pre-step：phase-1 消息过滤 + 晋升统计 ──
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision = await next() // 过滤时需要重建 decision 对象，必须可变（const 会静默炸掉过滤）
    try {
      const cfg = getConfig()
      const agent = payload.agent
      if (!cfg.enabled || !agent) return decision
      const model = agent.options?.model

      // 消息过滤（Pro phase-1 白名单；仅锚定期生效——晋升后恢复全量消息流，
      // 否则会把 workspace/skill-catalog 等注入上下文永久吞掉）
      let messages = decision?.kind === 'enter' ? (decision.messages ?? []) : []
      if (
        model === PRO_MODEL && cfg.proBoost &&
        cfg.proPhase1MessageSources.length > 0 &&
        isProAnchored(agent, shared) // 关键门控：只在 phase-1 过滤
      ) {
        const allowed = new Set(cfg.proPhase1MessageSources)
        const filtered = filterMessages(messages, allowed)
        if (filtered.length < messages.length) {
          messages = filtered
          if (decision?.kind === 'enter') decision = { ...decision, messages }
        }
      }

      // 晋升统计（步数用于 maxBootstrapSteps 兜底）
      // 关键：Flash agent 也必须建立 promotion 条目再计步——否则 steps 永远缺失，
      // isFlashAnchored 的步数兜底形同虚设，Flash 工具锚定会永不晋升（目录永久收窄）。
      const st = shared.promotion.get(agent) ?? promotionState(agent, shared)
      if (st) st.steps += 1
    } catch (e) {
      ctx.logger.warn(`[smart-router] pre-step boost failed: ${e?.message ?? e}`)
    }
    return decision
  })

  // ── agent/request：phase-1 输出预算封顶（bootstrapMaxTokens）──
  // 借鉴 liangshen：phase-1 请求 max_tokens=1024 是 "We need" 高命中窗口；晋升后剥离
  ctx.on('agent/request', async (payload, next) => {
    const proposal = await next()
    try {
      const cfg = getConfig()
      const agent = payload.agent
      if (!cfg.enabled || !agent) return proposal
      const model = effectiveModel(agent, agent.options?.model, shared, cfg)
      if (model !== PRO_MODEL || !cfg.proBoost) return proposal
      if (cfg.bootstrapMaxTokens > 0) {
        const anchored = isProAnchored(agent, shared)
        if (anchored && proposal.maxTokens === undefined) {
          return { ...proposal, maxTokens: cfg.bootstrapMaxTokens }
        }
      }
    } catch (e) {
      ctx.logger.warn(`[smart-router] request cap failed: ${e?.message ?? e}`)
    }
    return proposal
  })

  // ── system-prompt/assemble：persona + 工具锚定 ──
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      const cfg = getConfig()
      const agent = context?.agent
      const optionsModel = agent?.options?.model
      if (!cfg.enabled || !agent || !optionsModel) return result
      // 本请求实际模型（与 agent/request 路由一致）
      const model = effectiveModel(agent, optionsModel, shared, cfg)
      if (!shared.boostTargets || !shared.boostTargets.has(model)) return result

      if (model === FLASH_MODEL) {
        if (!cfg.flashBoost) return result
        const sections = setPersona(result, FLASH_PERSONA)
        // 复杂度思考指导是持续机制（每轮按 verdict 分发），不随首轮锚定释放而消失
        const dec = shared.decision.get(agent)
        const guide = dec?.verdict === 'heavy' ? GUIDE_DEEP : GUIDE_FAST
        sections.push({ name: 'smart-router:guide', text: guide })
        if (isFlashAnchored(agent, shared, cfg.flashMaxBootstrapSteps)) {
          const tools = anchorTools(result, cfg.flashAnchorTools)
          return { ...result, sections, tools, contexts: [] }
        }
        return { ...result, sections }
      }

      if (model === PRO_MODEL) {
        if (!cfg.proBoost) return result
        if (isProAnchored(agent, shared)) {
          // phase-1：minimal persona + 锚定工具 + 清空上下文（锚定幂等保证只锚一次）
          const sections = setPersona(result, MINIMAL_PERSONA)
          const tools = anchorTools(result, cfg.proAnchorTools)
          return { ...result, sections, tools, contexts: [] }
        }
        // 晋升后：恢复原 persona 与完整目录（只切换一次，不重锚）
        return result
      }
    } catch (e) {
      ctx.logger.warn(`[smart-router] boost failed: ${e?.message ?? e}`)
    }
    return result
  })
}
