# dsh-smart-router

DeepSeek Harness 智能路由插件：按任务复杂度自动切换 **deepseek-v4-pro / deepseek-v4-flash**（带总开关），并为两个模型提供「满血增强」——Pro 走两阶段锚定协议（liangshen / anchored-standard 风格），Flash 走 w7 persona + 首轮工具锚定 + 复杂度思考分发（flash-godmode 风格）。

> 对标本插件设计参考：penguin-oo/dsh-delegate-router（路由）、zhu1090093659/dsh-web · dsh-liangshen（Pro 锚定）、Cavan-Ou/dsh-flash-godmode（Flash 增强）。

## 功能

### 模块 A：智能路由
- **自动路由**：`agent/pre-step` 提取任务全文 → light/heavy 关键词双打分（支配规则：light 可否决 heavy，误判偏安全）→ 短任务阈值 / 峰谷降级 / 预算上限（读 cost-meter 账本，超限强制 Flash，fail-open）→ `agent/request` 改写模型
- **总开关**：设置页 `smart-router.enabled` 一键关闭
- **路由范围**：主会话默认不参与（`routeMainSession: false`），子代理默认参与（`routeSubagents: true`）
- **失败降级**：`agent/request-error` 挂钩（Pro↔Flash 切换重试，可关）
- **`/route` 命令**（会话级模式）：`/route auto | off | flash-all | pro-all` — 显式命令优先于自动路由与范围设置
- **账本**：每次路由决策写入会话事件 `smart-router/ledger`

### 模块 B：双模型满血
| 模型 | 机制 | 来源 |
|---|---|---|
| **Pro** | 两阶段锚定：phase-1 仅 minimal persona（46 字符）+ 官方双工具（bash + str_replace_editor）+ 白名单消息；晋升双条件（anchorGate：tool/call + minimal-like 思维块，四步兜底）+ waitForCompleteReply（无工具首轮完整回复后晋升）+ 锚定幂等（持久推导 + 步数兜底）+ 无工具兜底（放行全量） | dsh-liangshen / dsh-anchored-standard |
| **Flash** | w7 风格 persona（build/fix 分类 + 回顾锚 + 反跑题锚）+ 首轮工具锚定 + 复杂度思考指导（GUIDE_DEEP/FAST，verdict 驱动） | dsh-flash-godmode / dsh-router-flash |

- `proBoost` / `flashBoost` 分别开关
- 安全回退：任何注入失败只发裸 persona，绝不阻断请求

## 安装

```bash
# npm 发布后
dsh plugin --profile web add dsh-smart-router
# 或本地 / GitHub
dsh plugin --profile web add /path/to/dsh-smart-router
```

重启 Harness 生效。设置页出现 `smart-router` 分节。

## 配置（settings 命名空间 smart-router）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `routeMainSession` | false | 主会话参与路由 |
| `routeSubagents` | true | 子代理参与路由 |
| `lightKeywords` / `heavyKeywords` | 内置 | 关键词表（空=内置） |
| `shortTaskMaxChars` | 60 | 短任务阈值（中文建议 40-60） |
| `unknownToFlash` | false | 未知→Flash（激进） |
| `peakDemoteUnknown` / `peakHours` | false / [[9,12],[14,18]] | 峰谷降级 |
| `budgetCapTokens` | 0 | 单会话 token 预算上限（input+output+reasoning，不含缓存命中；依赖 dsh-cost-meter 提供用量，未安装时不限制；0 关闭） |
| `proBoost` / `flashBoost` | true / true | 满血开关 |
| `proAnchorTools` / `flashAnchorTools` | bash+str_replace_editor+pwsh+edit / read+write+str_replace_editor+edit | 首轮锚定工具（按实际目录过滤，全缺席放行） |
| `anchorGate` | true | 晋升门控（tool/call 后还需 minimal-like 思维块） |
| `promoteAfterFirstResponse` | true | 无工具首轮完整回复后晋升 |
| `proPhase1MessageSources` | [user, goal] | phase-1 消息白名单 |
| `bootstrapMaxTokens` | 1024 | phase-1 输出预算封顶 |
| `proMaxBootstrapSteps` / `flashMaxBootstrapSteps` | 4 / 2 | 锚定步数兜底 |
| `fallbackOnError` | true | 失败切换重试 |
| `ledgerEnabled` | true | 账本 |

## 验证

```bash
# 会话日志验证（路由是否生效）
node scripts/verify.mjs            # 读最近会话 session.jsonl.zstd，展示 request/header 模型变更与账本
```

## 路线图

- [x] P1 路由核心（评估 + 改写 + 开关 + 账本 + `/route` 命令）— **本机实测通过**
- [x] P2 预算跟踪（读 cost-meter 账本聚合 input+output+reasoning，超限强制 Flash，fail-open）— 依赖 dsh-cost-meter
- [x] P3/P4 满血增强（Pro 锚定含 liangshen 四增强点 + Flash 神模式）— **本机实测通过**
- [x] 单元测试 26/26 通过（`node tests/run.mjs`）
- [x] npm 包构建验证（`npm pack` → dsh-smart-router-0.1.0.tgz）
- [x] P5 失败降级代码（request-error 标记降级 + retry 切换模型；每 turn/step 至多一次，尊重其他恢复插件决策）
- [x] Pro resume 防御（request/header pro 强信号 → 直接 promoted，防 compaction 后重锚定）
- [x] guide 阈值统一（Flash 复杂度指导复用路由 verdict，移除二次正则评估）

## 已知边界与实现说明

- **失败降级**：`agent/request-error` 上只在无人接管（无显式 action）、信号未中止、提供方为 deepseek-official 时接管；每个 turn/step 至多切换一次模型。对 401 等不可恢复错误也只多花一次重试；同一步内连续失败不会在 Pro↔Flash 之间死循环。
- **锚定工具名**：默认锚定工具集同时覆盖官方对（bash / str_replace_editor）与 DSH 本体命名（pwsh / edit / read / write）；运行时按实际工具目录过滤，全部缺席则放行全量（无工具兜底）。
- **phase-1 白名单**：仅在 Pro 锚定期生效；晋升后消息全量放行（否则 workspace/skill-catalog 等注入上下文会被吞掉）。早期版本因 const 重赋值异常被静默吞掉导致过滤从未生效，已修复并有回归测试覆盖。
- **状态生命周期**：晋升/决策/会话模式以活跃 agent 对象为键存入 WeakMap，对象销毁自动回收，且免疫 agent id 复用串状态。
- **预算跟踪**：dsh-agent-loop 中 agent 与 session 共享同一调用方身份，故 `agent.id` 即 cost-meter 账本的 session 键；预算超限的强制 Flash 同步反映到 boost 组装侧模型推导。
- **热更新**：`anchorGate` / `promoteAfterFirstResponse` / `proMaxBootstrapSteps` 每次挂钩调用时从设置同步生效，无需重启。
- **peakHours**：区间为北京时间 `[start, end)`，不支持跨零点区间（如 [22,2] 请拆成两条）。
- [ ] 失败降级实测（模拟请求失败场景；单元+集成层已覆盖限次/协作语义，端到端待补）
- [ ] subagent per-call 覆盖（包装工具扩展 schema，增强项）
- [ ] 账本面板（桌面版 UI，二期）
- [ ] npm publish / GitHub 发布（待发布渠道决策）

## 许可证

MIT
