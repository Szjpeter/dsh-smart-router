// dsh-smart-router — 默认关键词表（可被 settings 覆盖）
// 借鉴 dsh-delegate-router v0.4.0 的规则：
// - ASCII 用 word-boundary 匹配；<2 字符的 CJK 关键词丢弃（防误匹配）
// - 表内自动去重（重复条目不再产生叠加权重）
// - 支配规则：heavy 需 heavyScore >= lightScore 才赢（light 可否决 heavy）

export const DEFAULT_LIGHT_KEYWORDS = Object.freeze([
  // 中文轻任务（含口语高频词：它们常出现在闲聊/短指令中，若留在 heavy 会把
  // "你可以测试"/"有问题吗" 这类短消息误判为重型任务升级 Pro）
  '搜索', '查询', '翻译', '总结', '列出', '查找', '简介', '概述', '解释', '换算', '格式化',
  '简单', '快速', '一句话', '简短', '标题', '命名', '测试', '问题', '错误',
  // 英文轻任务
  'search', 'find', 'lookup', 'query', 'translate', 'summarize', 'summarise', 'list',
  'quick', 'simple', 'brief', 'short', 'format', 'convert', 'rename', 'title', 'spell',
])

export const DEFAULT_HEAVY_KEYWORDS = Object.freeze([
  // 中文重任务（技术/工程语义词；口语高频词已移至 light 对冲）
  '重构', '架构', '设计', '调试', '优化', '分析', '实现', '开发', '构建', '系统', '全面',
  '详细', '复杂', '深入', '规划', '方案', '迁移', '集成', '部署', '安全', '性能',
  '修复', '异常', '兼容', '并发', '分布式',
  // 英文重任务
  'refactor', 'architecture', 'architect', 'design', 'debug', 'optimize', 'optimise',
  'implement', 'develop', 'build', 'comprehensive', 'detailed', 'complex', 'deep',
  'plan', 'migrate', 'integrate', 'deploy', 'secure', 'performance', 'concurrency',
  'distributed', 'fix', 'bug', 'error', 'exception', 'compat',
])

/** 预编译匹配器缓存：WeakMap 按关键词数组实例缓存，配置不变则零重建开销 */
const matcherCache = new WeakMap()

function compileMatchers(keywords) {
  const ascii = []   // RegExp[]
  const cjk = []     // string[]
  for (const kw of new Set(keywords)) {
    if (typeof kw !== 'string' || kw.length === 0) continue
    if (/^[\x21-\x7e]+$/.test(kw)) {
      const lower = kw.toLowerCase()
      ascii.push(new RegExp(`(?:^|[^a-z0-9])${escapeRe(lower)}(?:$|[^a-z0-9])`, 'i'))
    } else if (kw.length >= 2) {
      cjk.push(kw)
    }
  }
  return { ascii, cjk }
}

function getMatchers(list) {
  let m = matcherCache.get(list)
  if (!m) {
    m = compileMatchers(Array.isArray(list) ? list : [])
    matcherCache.set(list, m)
  }
  return m
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 关键词打分：命中计数（表内去重），ASCII 词边界匹配，CJK 全词包含匹配（长度>=2） */
export function keywordScore(text, matchers) {
  const m = getMatchers(matchers)
  let score = 0
  for (const re of m.ascii) if (re.test(text)) score += 1
  for (const kw of m.cjk) if (text.includes(kw)) score += 1
  return score
}

/** 复杂度评估：返回 { light, heavy, verdict: 'light'|'heavy'|'unknown'|'short' } */
export function evaluateComplexity(text, cfg) {
  const light = keywordScore(text, cfg.lightKeywords)
  const heavy = keywordScore(text, cfg.heavyKeywords)
  const len = text.length
  // 关键词优先（明确信号）：heavy 需 >= light（支配规则，light 可否决 heavy）
  if (heavy > 0 && heavy >= light) return { light, heavy, len, verdict: 'heavy' }
  if (light > 0 && light > heavy) return { light, heavy, len, verdict: 'light' }
  // 无关键词命中时：短任务 → short（启发式）
  if (cfg.shortTaskMaxChars > 0 && len > 0 && len <= cfg.shortTaskMaxChars) {
    return { light, heavy, len, verdict: 'short' }
  }
  return { light, heavy, len, verdict: 'unknown' }
}
