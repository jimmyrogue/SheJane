# SheJane Roadmap

> 更新日期：2026-06-13
>
> 结构约定：**未完成的事项按优先级 P0 → P4 排在前面**，每项附实现思路与参考方向；已完成的事项收在文末「已完成存档」，作为实现记录保留。完成一项就把它移到存档，避免双份状态。
>
> 本次优先级吸收了 2026-06-13 与现代 agent harness（Claude Code / Codex CLI / Cursor）的能力对标结论：P1 = 高收益低成本（基建现成），P2 = 中收益跟进，P4 = 高成本战略投资。

## 当前事实

- 旧 P0/P1/P2 主线已经完成：CI 修复、充值入口、欢迎页磁贴、安全与计费护栏、监控探针、自动备份、Stripe webhook 原子化、P2 体验功能和质量测试都已落地。
- 模型选择已经切到 **Auto + 后台模型目录**。用户端始终有 `Auto`，下面显示后台启用的 chat 模型。管理员用「模型 ID + 显示名 + provider_kind + key + base_url + model_name + 输入/输出 token 费率」配置模型；数据库字段仍叫 `slot`，只是历史字段名。
- `chat.fast` / `chat.deep` 仍作为种子模型 ID 保留，保证老配置可用；它们不再代表固定的产品层级。新的 chat 模型 ID 可以是 `gpt-4o`、`claude-sonnet`、`deepseek-v4` 等。
- `Auto` 由 Go API 统一解析：`POST /api/v1/models/resolve` 在 run 开始时从 enabled chat 模型里选一个，并发出 `model.selected`。daemon、本地 run、web cloud tool loop 都只传 `model="auto"` 或具体模型 ID。
- image 模型不进入聊天选择器。当前 resolver 只支持 `image.default`，后台也只允许 image capability 使用这个模型 ID。
- 平台付费 provider key 仍只在 Go API 侧使用。后台模型配置可以写入 provider key，但 key 加密存储且不回显；daemon 不读取这些 key。
- 文档入口收敛为 `CLAUDE.md`、`AGENTS.md`、`docs/run-loop.md`、`docs/client-sse-protocol.md`、`docs/operations.md`、本路线图。旧 status 快照、旧模型目录设计稿、旧 Node 架构图和 Phase 0 spike 报告已删除。
- 发布标签已对齐：`v0.1.9`（`3438f02`）包含生图重复回复修复（`3ec14c7`）和可配置模型目录（`1ff449d`）；main 仅领先一个 UI polish 提交（`151ec96`），下次打 tag 带上即可。
- 2026-06-13 harness 对标结论：HITL 权限、checkpoint/恢复、MCP 多源发现、Skills、中间件式自我纠错栈（plan-first / tool-critic / verification-loop / progress-ledger）已对齐甚至领先现代 harness；多 provider 模型目录和 Reserve→Settle 计费是参照物没有的差异化资产。主要缺口（mid-run steering、计划审批、subagent 配置化、语义摘要/记忆、Auto 可靠性路由）已按收益 × 难度编入下面的 P1/P2/P4。

## P0：发布与部署守门

| 任务 | 为什么优先 | 实现思路 / 参考方向 |
|---|---|---|
| 服务器部署后验证 | 当前改动跨 client/admin/api/daemon，必须用真实部署路径确认 wire contract。 | `make deploy` 后按清单核对：用户端模型选择器、Auto badge、admin 模型配置、图片生成、web search。流程见 `docs/operations.md`；建议把清单沉淀成 `make smoke-deploy` 脚本，后续每次发版复用。 |

## P1：高收益低成本的 harness 能力（基建现成，建议本周期内做）

| # | 任务 | 收益/难度 | 实现思路 / 参考方向 |
|---|---|---|---|
| 1 | **Mid-run steering：运行中追加用户指令** | 高 / 中低 | 长任务跑偏目前只能硬 cancel 重来，是当前最大的体验落差。思路：daemon 加 `POST /local/v1/runs/:id/inject`，pending 指令落 SQLite 队列；自定义中间件在 `before_model` 把排队消息注入下一轮上下文，并发 `steering.injected` SSE 事件；客户端 composer 在 run 进行中切换为「追加指示」输入。interrupt / checkpoint 基建全部现成，纯组装。参考：Claude Code 的 Esc 打断 + 追加指令心智。 |
| 2 | **计划审批模式（Plan Mode）** | 高 / 中低 | plan-first 中间件已能强制首轮 `write_todos`，但计划不经用户批准就执行。思路：计划产出后触发 interrupt（复用 `HumanInTheLoopMiddleware` 的暂停/恢复链路），permission 卡片扩展出「计划卡片」（批准 / 修改 / 拒绝）；批准前把工具面收紧为只读白名单（read/glob/grep/web.fetch 等）。与 #1 共享「运行中交互」的实现和心智，适合连着做。参考：Claude Code Plan Mode（EnterPlanMode/ExitPlanMode + 只读探索期）。 |
| 3 | **Artifact 面板升级** | 中高 / 低 | 每次会话都看得见的界面，体感/成本比最高。思路：代码块用 shiki（或 highlight.js）高亮；HTML/SVG 在 sandboxed iframe 渲染；Markdown 渲染、复制/下载按钮补齐。改动集中在 `client/src/features/chat` 的 artifact 组件。参考：Claude.ai Artifacts 面板。 |
| 4 | **subagent 配置化** | 中 / 低 | 目前只有硬编码的 researcher / writer。思路：`agent/subagents.py` 改为 loader——扫 `~/.shejane/agents/*.md`（frontmatter：name / description / tools 白名单 / prompt 正文），`build_subagents()` 动态产出 SubAgent 列表，复用现有 `SubAgentMiddleware`；之后 skills 可声明自带 subagent。改动面小、是后续能力的杠杆点。参考：Claude Code `.claude/agents/` 自定义 subagent 格式。 |

## P2：中收益跟进（第一梯队完成后）

| # | 任务 | 收益/难度 | 实现思路 / 参考方向 |
|---|---|---|---|
| 5 | checkpoint fork：从任意步重试 | 中 / 低 | AsyncSqliteSaver 已按 superstep 存档，数据都在。思路：用 LangGraph 原生 time-travel（`get_state_history` + 指定 `checkpoint_id` 起新分支），daemon 加 `POST /local/v1/runs/:id/fork {checkpoint_id}`；UI 在消息时间线上挂「从这一步重试」。与消息编辑重跑互补。 |
| 6 | Extended thinking 统一适配 | 中 / 中低 | `llm.reasoning` 事件目前只承载 DeepSeek thinking。思路：Go 网关 Anthropic 路由开启 extended thinking（thinking 预算后台可配），把 thinking 块统一映射到现有 `llm.reasoning` SSE 事件；daemon 和客户端零改动。 |
| 7 | MCP / Skills 在 UI 内增删改 | 中 / 中低 | 现在只能浏览 + 开关，复杂配置要手改文件。思路：daemon 加写接口（`POST/PUT/DELETE /local/v1/mcp-servers`、`/local/v1/skills`），写回 `~/.shejane/mcp-servers.json` 和 skills 目录；客户端做「Add Server」表单（stdio: command+args；http: url）和 SKILL.md 编辑器。注意只写 SheJane 自己的配置源，不回写 Claude Desktop / Cursor 的文件。 |
| 8 | web cloud tool loop 步数上限策略 | 高（web 用户）/ 中 | 云端/本地体验不对等的根源。思路：`hitStepCap` 从硬编码 5 改为后台可配；撞顶时不直接停，发一张「继续跑 N 步？」确认卡（复用 permission 卡片交互），用户确认后分段续跑，计费照常 Reserve/Settle。工程量不大，难点在步数与计费上限的产品决策——决策定了就能动。 |
| 9 | Auto 路由升级：可靠性/成本信号 + run 内降级 | 中高 / 中 | 现状：unbilled 分类器每 run 解析一次，候选只按后台 priority 排序，发 `model.selected` 带理由——任务感知和透明度已优于 Cursor（其 Auto 是启发式 per-request 路由，社区实测不感知任务且不透明）。缺口在可靠性维度。思路：① 聚合 `llm_call_records` 近窗错误率/延迟为 provider 健康分；② resolve 打分 = 任务分类 + priority + 健康分 + token 费率；③ `ModelRetryMiddleware` 重试耗尽时允许网关降级到候选次优模型，并再发一次 `model.selected`。明确不学 Cursor 的静默换模，保住透明度优势。 |
| 10 | 定时任务与结果通知 | 中高 / 中 | daemon 目前是严格前台单 run 模型；「定时跑一个 run + 推送结果」对 Chat 产品是差异化功能。思路：daemon 内置轻量 scheduler（asyncio 循环或 APScheduler），schedule 表存 SQLite；到点用既有 run 创建路径起 run，完成后走 Electron 系统通知。先做本机最小版，云端推送另议。参考：Claude Code scheduled tasks / cron 模式。 |
| 11 | 多文件附件 | 中低 / 中低 | 当前附件模型偏单文档，复杂资料任务被卡。思路：composer 支持多选；run 输入 schema 的 attachment 改列表（改 `api_schemas.py` 后 `make schemas`）；daemon 在 `<state>` 注入多文档引用，documents 服务（S3）本身已支持多文档。 |

## P3：运维硬化与产品补全

| 任务 | 为什么 | 实现思路 / 参考方向 |
|---|---|---|
| 镜像签名、SBOM、漏洞扫描 | 对外发布和服务器部署需要可追踪供应链。 | `release.yml` 加三步：cosign keyless 签名 GHCR 镜像、syft 生成 SBOM 附到 Release、trivy（或 grype）扫描作为发布 gate。参考 SLSA / GitHub attestations。 |
| 修 nightly external smoke 配置 | `STRIPE_WEBHOOK_SECRET` 等 secret 缺失会让金丝雀自己红。 | 补齐 GH Actions secrets；workflow 对缺失 secret 显式 skip + 告警注释，而不是红给后人猜。 |
| web 文档问答与工具组合策略 | 带附件和带工具的路径还没有统一的产品约束，容易出现能力互斥或用户困惑。 | 先做产品定义：附件 × 工具的组合/互斥矩阵（哪些组合支持、哪些降级、哪些提示）；再在 composer 做能力提示。先文档后代码。 |
| 键盘快捷键与帮助面板 | 长时间使用时，聚焦输入、切会话、停止、搜索这些操作应该更快。 | Cmd+K 切会话、Esc 停止、Cmd+N 新会话等；`?` 呼出快捷键帮助面板。可用 react-hotkeys-hook 或自研轻量 hook。 |
| Electron 主进程中文串接入 i18n | 英文用户仍可能看到中文系统弹窗。 | 把主进程字符串抽到与 renderer 共享的 locale 资源文件，启动时按系统语言选择。 |
| 中间件自我纠错栈对外文档化 | plan-first / reflect / tool-critic / verification-loop / progress-ledger 是相对 Claude Code 类 harness 的差异化资产（确定性、可配置、不依赖强模型），目前只散在代码和 run-loop.md 里。 | 从 `docs/run-loop.md` 中间件段落整理出一篇面向用户/评估者的能力说明。低成本填缝任务，适合发布间隙处理。 |

## P4：战略投资（高成本，需要专门排期）

| 任务 | 收益/难度 | 实现思路 / 参考方向 |
|---|---|---|
| 语义摘要 + 语义记忆（共享 embedding 基建） | 高 / 高 | 决定长任务质量上限，需要数周级投入；**两项绑定排期、embedding 基建只建一次**。思路：① embedding 经云网关代理并计费（与 LLM 同一 Reserve/Settle 模式），daemon 不持 key；② `store/sqlite.py` 的 `SqliteIndexConfig` 已为向量检索预留，启用后 `memory.search` 升级为语义召回；③ 上下文侧在 `max_history_turns` 触顶时用便宜模型做一次 LLM compact 替代纯丢弃，与 deepagents 运行中压缩统一策略；④ 记忆侧补 LLM 事实抽取、合并、过期验证。现状细节见存档「上下文管理」「长期记忆」各已完成项。 |
| 失败后的一键恢复工作流（统一 orchestrator） | 中 / 高 | 入口按钮已齐、单类恢复（retry/repair/quota/auth/workspace）已能用，缺跨 category 的统一编排。思路：把现有 per-target in-flight guard、pending target、余额观察等散点收敛成一个恢复状态机（failure category → 前置条件 → 确认 → 重跑），可继续按 category 渐进，不必整体重写。现状细节见存档对应项。 |
| 跨设备会话同步 | 中 / 高 | 现在聊天只在 IndexedDB，web/桌面互不可见。成本最高且依赖「本地优先隐私模型」的产品决策——决策未定前不投入工程。若做：对话元数据 + 消息经 Go API 同步（可选端到端加密），本地 run 工件仍留本地。 |

## 用户侧操作

| 状态 | 任务 | 备注 |
|---|---|---|
| [ ] | 轮换泄露过的 AWS key。 | 这是账号侧操作，代码无法代做。 |
| [ ] | tu-zi 图像令牌分组改到支持图片的分组。 | 后台账号侧配置。 |
| [ ] | GitHub Release 草稿 review / publish。 | 标签已对齐到 `v0.1.9`，可以直接 review / publish。 |

## 暂缓项

| 事项 | 处置 |
|---|---|
| macOS 签名公证 | 暂缓。需要 Apple Developer 账号和完整 notarization 流程，非当前阻塞。 |
| Windows 代码签名 | 暂缓。未签名会受 SmartScreen 影响，但可等分发链路稳定后处理。 |
| 移动端 App | 暂缓。本地 harness 跑在用户机器上，全移动端是另一条产品线。 |
| 会话分享/协作 | 先做产品决策。本地优先隐私模型天然不适合默认分享链接。 |
| 订单退款/取消 admin 动作 | 暂缓。当前 admin 订单保持只读，符合运维边界。 |
| 细粒度 admin RBAC | 暂缓。当前单一 admin 角色足够早期运营。 |
| 用户可配置生命周期 Hooks | 暂缓。中间件点位（before_agent / before_model / wrap_tool_call / after_model / after_agent）已存在，缺的只是暴露成用户配置；等高级用户/企业定制需求出现再做。 |
| Fork/Rewind 完整时间旅行 UI | 暂缓。P2 先做「从任意步重试」的最小版；完整的分支对比/并行探索 UI 等 checkpoint fork 验证后再说。 |

---

## 已完成存档

> 以下是已落地事项的实现记录，按原主题分组保留，作为「为什么是现在这个样子」的文档。

### 发布与 web loop

| 任务 | 实现记录 |
|---|---|
| 发布标签与 main 对齐 | 已发到 `v0.1.9`（`3438f02`），包含 `3ec14c7` 生图重复回复修复和 `1ff449d` 可配置模型目录。main 仅领先一个 UI polish 提交（`151ec96`），下次打 tag 带上即可。 |
| web 工具循环可中断 | `chatStore` 为 web cloud tool loop 持有 `AbortController`，Stop 会中断 LLM stream 和 Tool Gateway fetch，并把消息收束为 `run.canceled`。 |
| web 循环恢复兜底 | `chatStore` 会在会话加载/刷新时把 client-generated web tool-loop `run_...` streaming 消息收束为失败；server-backed cloud run 和 local run 不会被误伤。 |
| `hitStepCap` 给用户提示 | web loop 撞 5 步上限时会发 `run.budget_warning(reason=max_steps_reached)`，前端可展示预算上限提示。（上限策略本身仍在 P2 #8。） |

### 成本与契约

| 任务 | 实现记录 |
|---|---|
| prompt caching 全链路梳理 | Anthropic 自动 prompt caching 归 Go 模型网关统一处理：长 request 会加顶层 `cache_control={"type":"ephemeral"}`；daemon 不再暴露 provider-specific cache 标记。web/cloud loop 仍发送累计 history，Claude 路由可复用稳定前缀，真命中率需看真实 Anthropic usage。 |
| token 估算改进 | reservation 和 provider fallback 用完整 request 估算：messages、reasoning、tool call 参数、工具 name/description/inputSchema 都计入，减少工具密集轮的系统性少预留。 |
| Local Host 工具命名契约收敛 | `/local/v1/tools` 列出 deepagents filesystem/shell 当前名称和 schema，UI 标签覆盖 `glob` / `grep` / `file_path`，`fs.*` 留作未来 primitive 规范。 |
| web cloud 工具 schema 单一来源 | 生产代码已移除 `WEB_TOOL_DEFINITIONS`；web build 从 `/api/v1/agent/tool-capabilities` 读取 `description` / `inputSchema`。 |
| daemon / API gateway 工具 schema 契约测试 | `api/internal/httpapi/cloud_tool_schemas.json` 是 cloud gateway 工具的模型可见 schema artifact；Go capabilities 从它 embed，Python contract test 校验 `web.search`、`image.*`、`pdf.inspect`、`code.execute` 本地 schema 覆盖同一字段，并统一 `web.search.max_results`。 |
| run 级链路追踪 | `usage_reservations`、`llm_call_records` 与 `external_tool_call_records` 都保存 `run_id`；admin 可通过单 run trace 聚合 run 事件、LLM 调用、Tool Gateway 调用和该 run 相关钱包流水。 |
| 真 HTTP 契约测试覆盖 web cloud tool loop | client 有 `cloudToolLoop.contract.test.ts`，用真实 `fetch` / named SSE / 工具 response envelope 跑通 model→tool→model，并断言 Auto resolve、snake_case tool execute body、第二轮 history 和汇总 usage。 |

### 生产运维硬化

| 任务 | 实现记录 |
|---|---|
| Go API 带超时的 `http.Server` + 优雅关闭 | API 入口使用显式 `http.Server`，设置 read-header/read/idle timeout，并在 SIGINT/SIGTERM 下用 10s graceful shutdown；`WriteTimeout` 保持 0，避免误杀 SSE/streaming。 |
| 安全响应头 | Go API middleware 统一设置 API 安全头；Caddy 对 client/admin 站点设置 HSTS、CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 和 Permissions-Policy。 |
| 生产弱默认密钥 fail-fast | 生产栈注入 `SHEJANE_ENV=production`；API 启动用 strict config loader，`JWT_SECRET` / `CONFIG_ENCRYPTION_KEY` 为空、过短或常见占位值时直接启动失败。 |
| 数据库迁移版本表 | API 镜像内置 `shejane-migrate` 和 SQL migrations；`make migrate`、dev compose、prod compose 和 CI 走同一个 runner，写入 `schema_migrations(version,name,checksum,applied_at)`，已应用且 checksum 一致的版本跳过，checksum 漂移 fail-fast。 |

### 产品体验

| 任务 | 实现记录 |
|---|---|
| client 对 429 专门处理 | `SheJaneAPI` 抛带 `status` / `retryAfterSeconds` 的 `APIError`，解析 `Retry-After` 秒数或 HTTP date；chat store 把 429 显示成“请求太频繁，请在 X 后再试”的本地化提示。 |

### Agent 引擎深度

| 任务 | 实现记录 |
|---|---|
| 历史截断上限可配置 | daemon 新增 `max_history_turns` / `SHEJANE_LOCAL_MAX_HISTORY_TURNS`，Advanced 面板可按 run 覆盖；默认 40，超上限时在 `<state>` 提示 dropped count；client 先压缩出的 omission marker 在 daemon 二次截断时保留为压缩锚点。（语义摘要升级在 P4。） |
| 长任务交接摘要首版 | `/local/v1/runs/{id}/diagnostics` 返回 `handoff`，从状态、事件类型、权限、artifact metadata 和最近失败派生交接摘要；诊断面板展示，不暴露 artifact 正文或 checkpoint messages。 |
| 长任务进展账本首版 | 新增 `task.progress`，agent 可主动记录验收标准、关键决策、涉及文件、验证命令、未解决风险和下一步；最新 `progress_ledger` 作为 `feature_ledger` 出现在 diagnostics 和诊断面板。 |
| 交接账本新鲜度检查 | `handoff.ledger_state` 标记 `not_required` / `fresh` / `missing` / `stale`；需要交接的完成、失败、取消或等待权限 run 中，缺失/陈旧账本进入 blockers 和 next actions；等待中的本地 run 也会在聊天进度行提示缺失/陈旧账本风险，权限审批仍在独立 approval bar。 |
| 结束前进展账本刷新 guard | `ProgressLedgerGuardMiddleware` 在本地 agent 准备输出最终答案时检查：如果本 run 做过非 `task.progress` 工具工作且最后一次工具结果之后没刷新账本，最多跳回模型一次要求先调用 `task.progress`。 |
| 长期记忆 namespace 隔离 | workspace run 的 writeback 和 `memory.search` 按 workspace hash 写入/检索独立 namespace；无 workspace run 保留 legacy global namespace，清空记忆删除全部 `notes` namespace。 |
| 显式用户事实记忆首版 | 普通 run 写 `kind=run_note` 摘要；用户明确说 `remember...` / `记住...` 时额外写 `kind=user_fact` + `source=explicit_user_request`，不从普通对话或 assistant 回答里猜事实。`memory.search` 有界多取候选后做 user_fact-first、同类较新优先排序。（语义检索升级在 P4。） |
| 验证回环首版 | `VerificationLoopMiddleware` 在 `task.verify` 明确失败且模型准备结束时，最多按 `SHEJANE_LOCAL_VERIFY_REPAIR_MAX` 跳回模型修复并要求重新验证；LLM critic 分数保持 advisory。 |
| 错误分类诊断首版 | `handoff.failure` 把最近 `run.failed` / `tool.failed` 分成 transient、auth、quota、permission、configuration、workspace、validation、fatal 或 unknown，给出 recoverable / retryable / action_kind / suggested action；诊断面板和失败进度文案渲染本地化策略标签，`ok:false` 工具结果 envelope 进入 `tool.failed`。 |
| Cloud Tool Gateway 网关层退避重试 | Local Host 调 `web.search`、`image.*`、`pdf.inspect`、`code.execute` 时，transport 层 `httpx.HTTPError` 和非 JSON 瞬态 HTTP 响应（429/500/502/503/504）按 `max_tool_retries` 有界指数退避重试，复用同一个 idempotency key；结构化 tool result envelope 不自动重试。 |
| 模型/工具重试预算拆分 | daemon 新增 `max_model_retries` / `SHEJANE_LOCAL_MAX_MODEL_RETRIES`，Advanced 面板可分别设置模型网关瞬时失败重试和工具失败重试，避免 `ModelRetryMiddleware` 误用工具重试预算。 |
| 自动退避策略首版 | `failure_policy.build_retry_decision` 统一把 `handoff.failure.action_kind` / category / retryable 映射成 `should_retry`、退避秒数和 fail-fast reason；模型错误、结构化 tool-result 重试、Cloud Tool Gateway transport / 非 JSON 瞬态 HTTP 重试走同一策略，quota/auth/config/workspace/validation/fatal 即使误带 `retryable:true` 也不自动重试。 |
| 失败后的用户动作引导首版 | `run.failed` 即使没有工具事件也会在聊天进度条出现；`user_action` / `repair` / `operator_action` 根据 failure category 显示本地化下一步（重新登录、补充额度、补齐配置、授权工作区、修正参数、查看日志）。 |
| 失败后的动作按钮首版 | 失败进度条把 retry / repair / quota / auth / workspace / diagnostics 类失败转成显式按钮：重试、尝试修复、充值、刷新本地云端会话、选择工作区或查看诊断；按钮只在用户点击时触发，不自动重跑副作用工具。恢复确认绑定失败来源 conversation/message，retry/repair run 写入 `metadata.intent`、source run/message、attempt 与失败分类，daemon 在 `<state>` 注入重试/修复上下文；同一失败消息的 checkout / retry / repair 均有 per-target in-flight guard；充值后的“重试”先刷新钱包余额，repair 受 `SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX` 约束并发出 `repair.workflow` 生命周期事件。（统一 orchestrator 在 P4。） |
| browser.task 未配置时下架 | `browser-use` + browser LLM 未接线时，registry 不把 stub 暴露给 `/local/v1/tools` 或 agent toolset；真正浏览器自动化另起接入任务。 |
| HITL 多工具审批批次恢复 | deepagents 同一个 interrupt 可带多个 `action_requests`；daemon 等待当前 pause 批次所有 `permission.required` 都 resolved，再按原顺序用 `{"decisions": [...]}` resume。`permission.resolved` / `question.answered` 持久化并在恢复流中先于 `run.resumed` 出现。 |
