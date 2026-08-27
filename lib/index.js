// dsh-smart-router — 主入口
// 模块 A 智能路由（agent/pre-step 评估 + agent/request 改写 + agent/request-error 降级）
// 模块 B 双模型满血（system-prompt/assemble：Pro 锚定 / Flash 神模式）
// 设置：settings 命名空间 smart-router（UI 一键开关）
import { createSchema, resolveConfig, NS } from './settings.js'
import { DEFAULT_LIGHT_KEYWORDS, DEFAULT_HEAVY_KEYWORDS } from './keywords.js'
import { installRouter, PRO_MODEL, FLASH_MODEL } from './router.js'
import { installBoost } from './boost.js'

export const name = 'dsh-smart-router'

export const inject = ['settings', 'commands']

export async function apply(ctx, config) {
  // ── 1. 注册设置命名空间（UI 开关与配置；entry config 作为 base 层）──
  try {
    ctx.settings.register(NS, createSchema(), { base: config })
  } catch (e) {
    ctx.logger.warn(`[smart-router] settings register failed: ${e?.message ?? e}`)
  }

  // ── 2. 实时配置读取（每次调用读最新，支持热更新）──
  const defaults = { light: DEFAULT_LIGHT_KEYWORDS, heavy: DEFAULT_HEAVY_KEYWORDS }
  const getConfig = () => {
    let raw = {}
    try {
      raw = ctx.settings?.get?.(NS) ?? {}
    } catch {
      raw = {} // settings 未就绪 → 全默认
    }
    const cfg = resolveConfig(raw, defaults)
    // 同步晋升门控参数到共享状态（运行中热更新真实生效；供 promotionState 读取）
    shared.anchorGate = cfg.anchorGate
    shared.promoteAfterFirstResponse = cfg.promoteAfterFirstResponse
    shared.proMaxBootstrapSteps = cfg.proMaxBootstrapSteps
    return cfg
  }

  // ── 3. 共享状态 ──
  // WeakMap 以活跃 agent 对象为键：对象销毁自动回收，且免疫 id 复用串状态；
  // fallback 两张表以 `${id}|${turn}|${step}` 为键、容量裁剪（每步至多一次降级换轨）。
  const shared = {
    promotion: new WeakMap(),   // Agent -> {phase, toolCalled, responded, anchored, proSeen, steps}
    decision: new WeakMap(),    // Agent -> {verdict, light, heavy, len}（router 评估 / boost 读取）
    sessionModes: new WeakMap(),// Agent -> 'auto'|'off'|'flash-all'|'pro-all'（/route 命令）
    fallbackMarks: new Map(),   // `${id}|turn|step` -> 1（该步已消耗降级机会）
    fallbackPending: new Map(), // `${id}|turn|step` -> 1（待下一次 request 消费并换轨）
    boostTargets: new Set([PRO_MODEL, FLASH_MODEL]),
    anchorGate: true,
    promoteAfterFirstResponse: true,
    proMaxBootstrapSteps: 4,
  }

  // ── 4. 安装两个模块（installRouter 先注册，保证 assemble 内层顺序：先评估后增强）──
  installRouter(ctx, getConfig, shared)
  installBoost(ctx, getConfig, shared)

  ctx.logger.info(`[smart-router] loaded (pro=${PRO_MODEL} flash=${FLASH_MODEL})`)
}
