// dsh-smart-router — settings schema（UI 一键开关与配置）
// 命名空间：smart-router
// 默认值单一来源：DEFAULTS 同时驱动 schema 与 resolveConfig，杜绝双表漂移。
import z from '@deepseek-ai/schemastery'

export const NS = 'smart-router'

/** 运行时默认值（唯一事实源；lightKeywords/heavyKeywords 的 [] 是“使用内置词表”哨兵） */
export const DEFAULTS = Object.freeze({
  enabled: true,
  routeMainSession: false,
  routeSubagents: true,
  lightKeywords: [],
  heavyKeywords: [],
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
})

export function createSchema() {
  // 克隆引用类型，避免 schema 默认值与运行时共享可变数组
  const d = structuredClone(DEFAULTS)
  return z.object({
    // ── 总开关 ──
    enabled: z.boolean().default(d.enabled)
      .description('智能路由总开关'),

    // ── 路由范围 ──
    routeMainSession: z.boolean().default(d.routeMainSession)
      .description('主会话参与路由（默认关：主会话保持默认模型）'),
    routeSubagents: z.boolean().default(d.routeSubagents)
      .description('子代理参与路由（默认开）'),

    // ── 路由规则 ──
    lightKeywords: z.array(z.string()).default(d.lightKeywords)
      .description('轻任务关键词（留空用内置表）'),
    heavyKeywords: z.array(z.string()).default(d.heavyKeywords)
      .description('重任务关键词（留空用内置表）'),
    shortTaskMaxChars: z.number().default(d.shortTaskMaxChars)
      .description('短任务字符阈值（<=此长度判为轻任务；0 关闭。中文任务建议 40-60）'),
    unknownToFlash: z.boolean().default(d.unknownToFlash)
      .description('未知复杂度 → Flash（激进，默认关：未知保持原模型）'),

    // ── 峰谷 / 预算（可选）──
    peakDemoteUnknown: z.boolean().default(d.peakDemoteUnknown)
      .description('北京时间高峰时段未知任务降级 Flash'),
    peakHours: z.array(z.array(z.number())).default(d.peakHours)
      .description('高峰时段 [[开始,结束],...] 北京时间（不支持跨零点区间）'),
    budgetCapTokens: z.number().default(d.budgetCapTokens)
      .description('单会话 token 预算上限（input+output+reasoning，不含缓存命中；依赖 dsh-cost-meter 提供用量，未安装时不限制；0 关闭）'),

    // ── 满血增强开关 ──
    proBoost: z.boolean().default(d.proBoost)
      .description('Pro 锚定满血（minimal persona + 双工具首轮锚定 + 晋升恢复）'),
    flashBoost: z.boolean().default(d.flashBoost)
      .description('Flash 神模式增强（w7 persona + 首轮工具锚定 + 复杂度思考指导）'),

    // ── 首轮锚定工具集（按名过滤，不存在的名字自动忽略；全部缺席则放行全量）──
    proAnchorTools: z.array(z.string()).default(d.proAnchorTools)
      .description('Pro 首轮锚定工具集（覆盖官方对与 DSH 本体命名）'),
    flashAnchorTools: z.array(z.string()).default(d.flashAnchorTools)
      .description('Flash 首轮锚定工具集'),
    proMaxBootstrapSteps: z.number().default(d.proMaxBootstrapSteps)
      .description('Pro 锚定兜底：N 步后强制晋升（防永久双工具会话）'),
    flashMaxBootstrapSteps: z.number().default(d.flashMaxBootstrapSteps)
      .description('Flash 锚定兜底：N 步后强制晋升'),

    // ── Pro 锚定进阶（借鉴 dsh-liangshen）──
    anchorGate: z.boolean().default(d.anchorGate)
      .description('晋升门控：tool/call 后还需 minimal-like 思维块（we 无 let me）才晋升完整目录'),
    promoteAfterFirstResponse: z.boolean().default(d.promoteAfterFirstResponse)
      .description('无工具调用的首轮在完整回复后自动晋升（waitForCompleteReply）'),
    proPhase1MessageSources: z.array(z.string()).default(d.proPhase1MessageSources)
      .description('Pro phase-1 消息源白名单（仅锚定期生效；只放行这些 source kind）'),
    bootstrapMaxTokens: z.number().default(d.bootstrapMaxTokens)
      .description('Pro phase-1 输出预算封顶（1024 是 "We need" 高命中窗口；0 关闭）'),

    // ── 失败降级 ──
    fallbackOnError: z.boolean().default(d.fallbackOnError)
      .description('请求失败时切换模型重试（Pro<->Flash；每 turn/step 至多一次）'),

    // ── 记账 ──
    ledgerEnabled: z.boolean().default(d.ledgerEnabled)
      .description('记录路由账本（session 事件）'),
  })
}

/** 解析配置：raw 值优先，缺省回落 DEFAULTS；空关键词表回落内置词表 */
export function resolveConfig(raw, keywords) {
  const cfg = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      const v = raw[k]
      if (v !== undefined && v !== null) cfg[k] = v
    }
  }
  if (!Array.isArray(cfg.lightKeywords) || cfg.lightKeywords.length === 0) cfg.lightKeywords = keywords.light
  if (!Array.isArray(cfg.heavyKeywords) || cfg.heavyKeywords.length === 0) cfg.heavyKeywords = keywords.heavy
  return cfg
}

/** 北京时间是否高峰（区间 [start,end)，不支持跨零点） */
export function isPeakHour(hours) {
  if (!Array.isArray(hours)) return false
  const now = new Date()
  const bjHour = (now.getUTCHours() + 8) % 24 // 北京时间 = UTC+8
  return hours.some(([start, end]) => bjHour >= start && bjHour < end)
}
