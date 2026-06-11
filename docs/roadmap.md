# SheJane Roadmap

> 更新日期：2026-06-10
>
> 这份文档只保留当前还需要执行或持续守住的事项。已完成的大段历史不再放在路线图里，避免把过期阶段当成待办。

## 当前事实

- 旧 P0/P1/P2 主线已经完成：CI 修复、充值入口、欢迎页磁贴、安全与计费护栏、监控探针、自动备份、Stripe webhook 原子化、P2 体验功能和质量测试都已落地。
- 模型选择已经切到 **Auto + 后台模型目录**。用户端始终有 `Auto`，下面显示后台启用的 chat 模型。管理员用「模型 ID + 显示名 + provider_kind + key + base_url + model_name」配置模型；数据库字段仍叫 `slot`，只是历史字段名。
- `chat.fast` / `chat.deep` 仍作为种子模型 ID 保留，保证老配置可用；它们不再代表固定的产品层级。新的 chat 模型 ID 可以是 `gpt-4o`、`claude-sonnet`、`deepseek-v4` 等。
- `Auto` 由 Go API 统一解析：`POST /api/v1/models/resolve` 在 run 开始时从 enabled chat 模型里选一个，并发出 `model.selected`。daemon、本地 run、web cloud tool loop 都只传 `model="auto"` 或具体模型 ID。
- image 模型不进入聊天选择器。当前 resolver 只支持 `image.default`，后台也只允许 image capability 使用这个模型 ID。
- 平台付费 provider key 仍只在 Go API 侧使用。后台模型配置可以写入 provider key，但 key 加密存储且不回显；daemon 不读取这些 key。
- 文档入口收敛为 `CLAUDE.md`、`AGENTS.md`、`docs/run-loop.md`、`docs/client-sse-protocol.md`、`docs/operations.md`、本路线图。旧 status 快照、旧模型目录设计稿、旧 Node 架构图和 Phase 0 spike 报告已删除。

## P0：先保证发布和 web loop 可控

| 状态 | 任务 | 为什么优先 |
|---|---|---|
| [ ] | **发布标签与 main 对齐**：远端 `v0.1.6` tag 仍在 `000486a`，未包含 `3ec14c7` 生图重复回复修复和 `1ff449d` 可配置模型目录。决定是重打 `v0.1.6`，还是发 `v0.1.7`。 | 否则 GHCR 镜像、桌面草稿 Release 和服务器部署会拿到旧提交，刚修好的模型目录和生图重复回复修复都不会进包。 |
| [ ] | 服务器部署后验证：`make deploy`，然后检查用户端模型选择器、Auto badge、admin 模型配置、图片生成、web search。 | 当前改动跨 client/admin/api/daemon，必须用真实部署路径确认 wire contract。 |
| [x] | web 工具循环可中断：Stop 按钮需要能 abort `runCloudToolLoop`。 | `chatStore` 现在为 web cloud tool loop 持有 `AbortController`，Stop 会中断 LLM stream 和 Tool Gateway fetch，并把消息收束为 `run.canceled`。 |
| [x] | web 循环恢复兜底：打开会话时把无主 `streaming` 消息标记失败。 | `chatStore` 会在会话加载/刷新时把 client-generated web tool-loop `run_...` streaming 消息收束为失败；server-backed cloud run 和 local run 不会被误伤。 |
| [x] | `hitStepCap` 给用户提示。 | web loop 撞 5 步上限时现在会发 `run.budget_warning(reason=max_steps_reached)`，前端可展示预算上限提示。 |

## P1：成本与契约

| 状态 | 任务 | 为什么 |
|---|---|---|
| [x] | prompt caching 全链路梳理。 | Anthropic 自动 prompt caching 现在归 Go 模型网关统一处理：长 request 会加顶层 `cache_control={"type":"ephemeral"}`；daemon 不再暴露 provider-specific cache 标记。web/cloud loop 仍会发送累计 history，但 Claude 路由可复用稳定前缀，真命中率需看真实 Anthropic usage。 |
| [x] | token 估算改进。 | reservation 和 provider fallback 现在用完整 request 估算：messages、reasoning、tool call 参数、工具 name/description/inputSchema 都计入，减少工具密集轮的系统性少预留。 |
| [x] | Local Host 当前工具命名契约收敛。 | `/local/v1/tools` 现在列出 deepagents filesystem/shell 当前名称和 schema，UI 标签覆盖 `glob` / `grep` / `file_path`，`fs.*` 留作未来 primitive 规范。 |
| [x] | web cloud 工具 schema 单一来源。 | 生产代码已移除 `WEB_TOOL_DEFINITIONS`；web build 现在从 `/api/v1/agent/tool-capabilities` 读取 `description` / `inputSchema`。 |
| [x] | daemon / API gateway 工具 schema 契约测试。 | `api/internal/httpapi/cloud_tool_schemas.json` 是 cloud gateway 工具的模型可见 schema artifact；Go capabilities 从它 embed，Python contract test 校验 `web.search`、`image.*`、`pdf.inspect`、`code.execute` 本地 schema 覆盖同一字段，并统一 `web.search.max_results`。 |
| [x] | run 级链路追踪。 | `usage_reservations`、`llm_call_records` 与 `external_tool_call_records` 现在都保存 `run_id`；admin 可通过单 run trace 聚合 run 事件、LLM 调用、Tool Gateway 调用和该 run 相关钱包流水。 |
| [x] | 真 HTTP 契约测试覆盖 web cloud tool loop。 | client 现在有 `cloudToolLoop.contract.test.ts`，用真实 `fetch` / named SSE / 工具 response envelope 跑通 model→tool→model，并断言 Auto resolve、snake_case tool execute body、第二轮 history 和汇总 usage。 |

## P2：生产运维硬化

| 状态 | 任务 | 为什么 |
|---|---|---|
| [x] | Go API 换带超时的 `http.Server` 并支持优雅关闭。 | API 入口使用显式 `http.Server`，设置 read-header/read/idle timeout，并在 SIGINT/SIGTERM 下用 10s graceful shutdown；`WriteTimeout` 保持 0，避免误杀 SSE/streaming。 |
| [x] | 安全响应头：HSTS、CSP、X-Frame-Options、X-Content-Type-Options。 | Go API middleware 统一设置 API 安全头；Caddy 对 client/admin 站点设置 HSTS、CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 和 Permissions-Policy。 |
| [x] | 生产弱默认密钥 fail-fast。 | 生产栈注入 `SHEJANE_ENV=production`；API 启动改用 strict config loader，`JWT_SECRET` / `CONFIG_ENCRYPTION_KEY` 为空、过短或常见占位值时直接启动失败。 |
| [x] | 数据库迁移版本表。 | API 镜像内置 `shejane-migrate` 和 SQL migrations；`make migrate`、dev compose、prod compose 和 CI 都走同一个 runner，写入 `schema_migrations(version,name,checksum,applied_at)`，已应用且 checksum 一致的版本会跳过，checksum 漂移会 fail-fast。 |
| [ ] | 镜像签名、SBOM、漏洞扫描。 | 对外发布和服务器部署需要可追踪供应链。 |
| [ ] | 修 nightly external smoke 配置。 | `STRIPE_WEBHOOK_SECRET` 等 secret 缺失会让金丝雀自己红。 |

## P3：产品体验

| 状态 | 任务 | 为什么 |
|---|---|---|
| [ ] | 跨设备会话同步方案。 | 现在聊天只在 IndexedDB，本地优先没问题，但 web/桌面互不可见。 |
| [ ] | web 文档问答与工具组合策略。 | 带附件和带工具的路径还没有统一的产品约束，容易出现能力互斥或用户困惑。 |
| [x] | client 对 429 做专门处理。 | `SheJaneAPI` 现在抛带 `status` / `retryAfterSeconds` 的 `APIError`，解析 `Retry-After` 秒数或 HTTP date；chat store 会把 429 显示成“请求太频繁，请在 X 后再试”的本地化提示。 |
| [ ] | 多文件附件。 | 当前附件模型偏单文档，复杂资料任务会被卡住。 |
| [ ] | Artifact 面板升级。 | 现在预览能力够用但不够像成品：代码高亮、HTML/SVG/Markdown 渲染、复制和下载还可增强。 |
| [ ] | MCP / Skills 在 UI 内增删改。 | 现在主要是浏览和开关，复杂配置仍要手改文件。 |
| [ ] | 键盘快捷键与帮助面板。 | 长时间使用时，聚焦输入、切会话、停止、搜索这些操作应该更快。 |
| [ ] | Electron 主进程中文串接入 i18n。 | 英文用户仍可能看到中文系统弹窗。 |

## P4：Agent 引擎深度

| 状态 | 任务 | 为什么 |
|---|---|---|
| [x] | 历史截断上限可配置。 | daemon 新增 `max_history_turns` / `SHEJANE_LOCAL_MAX_HISTORY_TURNS`，Advanced 面板可按 run 覆盖；默认仍是 40，超过上限时继续在 `<state>` 提示 dropped count；client 先压缩出的 omission marker 在 daemon 二次截断时会被保留为压缩锚点。 |
| [ ] | 上下文管理升级：语义历史摘要和 deepagents 压缩协调。 | 现在已有可调截断、确定性早期历史摘要和两层压缩 marker 保护，避免纯丢弃或二次截断吃掉摘要；仍缺 LLM/semantic summary、摘要新鲜度和与 deepagents 运行中压缩的统一策略。 |
| [x] | 长任务交接摘要首版。 | `/local/v1/runs/{id}/diagnostics` 现在返回 `handoff`，从状态、事件类型、权限、artifact metadata 和最近失败派生交接摘要；诊断面板会展示它，仍不暴露 artifact 正文或 checkpoint messages。 |
| [x] | 长任务进展账本首版。 | 新增 `task.progress`，agent 可主动记录验收标准、关键决策、涉及文件、验证命令、未解决风险和下一步；最新 `progress_ledger` 会作为 `feature_ledger` 出现在 diagnostics 和诊断面板。 |
| [x] | 交接账本新鲜度检查。 | `handoff.ledger_state` 会标记 `not_required` / `fresh` / `missing` / `stale`；需要交接的完成、失败、取消或等待权限 run 中，缺失/陈旧账本会进入 blockers 和 next actions，诊断面板直接展示状态；等待中的本地 run 也会在聊天进度行提示缺失/陈旧账本风险，但权限审批仍保留在独立 approval bar。 |
| [x] | 结束前进展账本刷新 guard。 | `ProgressLedgerGuardMiddleware` 会在本地 agent 准备输出最终答案时检查：如果本 run 做过非 `task.progress` 工具工作，且最后一次工具结果之后没有刷新账本，就最多跳回模型一次要求先调用 `task.progress`。 |
| [x] | 长期记忆 namespace 隔离。 | workspace run 的 writeback 和 `memory.search` 现在按 workspace hash 写入/检索独立 namespace；无 workspace run 保留 legacy global namespace，清空记忆会删除全部 `notes` namespace。 |
| [x] | 显式用户事实记忆首版。 | 普通 run 仍写 `kind=run_note` 摘要；用户明确说 `remember...` / `记住...` 时会额外写 `kind=user_fact` + `source=explicit_user_request`，不从普通对话或 assistant 回答里猜事实。 |
| [ ] | 长期记忆升级：语义检索、LLM 事实抽取、陈旧事实验证。 | 现在仍主要是 append-only 记录和子串匹配；已有显式 user_fact，`memory.search` 会有界多取候选后再做 user_fact-first、同类较新优先排序，避免小 limit 把显式事实截掉或让旧显式事实长期压住新事实，但还不会用 LLM/embedding 抽取、合并、刷新或验证事实。 |
| [x] | 验证回环（首版）。 | `VerificationLoopMiddleware` 现在会在 `task.verify` 明确失败且模型准备结束时，最多按 `SHEJANE_LOCAL_VERIFY_REPAIR_MAX` 跳回模型修复并要求重新验证；LLM critic 分数仍保持 advisory。 |
| [x] | 错误分类诊断首版。 | `handoff.failure` 会把最近 `run.failed` / `tool.failed` 分成 transient、auth、quota、permission、configuration、workspace、validation、fatal 或 unknown，并给出 recoverable / retryable / action_kind / suggested action；诊断面板和普通失败进度文案都会渲染本地化策略标签，`ok:false` 工具结果 envelope 会进入 `tool.failed`。 |
| [x] | Cloud Tool Gateway 网关层退避重试。 | Local Host 调 `web.search`、`image.*`、`pdf.inspect`、`code.execute` 时，transport 层 `httpx.HTTPError` 和非 JSON 瞬态 HTTP 响应（429/500/502/503/504）会按 `max_tool_retries` 有界指数退避重试，并复用同一个 idempotency key；结构化 tool result envelope 不自动重试。 |
| [x] | 模型/工具重试预算拆分。 | daemon 新增 `max_model_retries` / `SHEJANE_LOCAL_MAX_MODEL_RETRIES`，Advanced 面板可分别设置模型网关瞬时失败重试和工具失败重试，避免 `ModelRetryMiddleware` 误用工具重试预算。 |
| [x] | 自动退避策略首版。 | `failure_policy.build_retry_decision` 现在统一把 `handoff.failure.action_kind` / category / retryable 映射成 `should_retry`、退避秒数和 fail-fast reason；模型错误、结构化 tool-result 重试、Cloud Tool Gateway transport / 非 JSON 瞬态 HTTP 重试都走同一策略，quota/auth/config/workspace/validation/fatal 即使误带 `retryable:true` 也不会自动重试。 |
| [x] | 失败后的用户动作引导首版。 | `run.failed` 即使没有工具事件也会在聊天进度条里出现；`user_action` / `repair` / `operator_action` 会根据 failure category 显示本地化下一步，例如重新登录、补充额度、补齐配置、授权工作区、修正参数或查看日志。 |
| [x] | 失败后的动作按钮首版。 | 普通失败进度条现在会把 retry / repair / quota / auth / workspace / diagnostics 类失败转成用户显式按钮：重试、尝试修复、充值、刷新本地云端会话、选择工作区或查看诊断；按钮只在用户点击时触发，不自动重跑副作用工具。 |
| [ ] | 失败后的一键恢复工作流。 | 仍缺配置修复后的完整 resume/retry 编排；按钮入口已经可见，本地云端会话刷新、工作区绑定成功、充值页面打开或诊断面板打开后会给“重试”确认入口，且这些确认会绑定失败来源 conversation/message，避免用户切换对话或等待 OS 目录选择器返回时把恢复动作写到错误对话。auth/session 类恢复如果当下刷新失败，会保留同一个失败 turn 的 pending target；用户重新登录或 token 修复后，只要自动 session sync 变成 `connected`，就刷新显式“重试”确认，但不会自动重跑任务。恢复确认的“重试”现在有 per-target in-flight guard，重复点击同一个失败消息的恢复 toast 不会并发创建多个替换 run；用户确认后的 retry run 也会写入 `metadata.intent=retry`、source run/message、attempt 与失败分类，并让 daemon 在 `<state>` 注入重试上下文。充值后的“重试”会先刷新钱包余额，只有后端已反映新增可用额度/订阅容量才重跑失败任务；同一个失败消息的 checkout 创建请求也有 per-target in-flight guard，避免连续点击打开多个 Stripe session；打开 checkout 后会静默进行有界余额观察，一旦后端反映充值/套餐容量已生效，就刷新为显式“重试”确认，但不会自动重跑失败任务。`repair` 类失败已有用户可控入口，并会给新 run 写入 `metadata.intent=repair`、source run/message、attempt 与失败分类；daemon 会按 `SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX` 约束 repair attempt、向 `<state>` 注入修复上下文，并发出 `repair.workflow` started/completed/failed/rejected/canceled 事件；连续点击同一个“尝试修复”不会创建重复 repair run。仍缺跨 auth / billing / config / workspace / repair 的统一恢复 orchestrator。 |
| [x] | browser.task 未配置时从模型工具面下架。 | `browser-use` + browser LLM 未接线时，registry 不再把 stub 暴露给 `/local/v1/tools` 或 agent toolset；后续真正浏览器自动化可另起接入任务。 |
| [x] | HITL 多工具审批批次恢复。 | deepagents 同一个 interrupt 可带多个 `action_requests`；daemon 现在会等待当前 pause 批次的所有 `permission.required` 都 resolved，再按原顺序用 `{"decisions": [...]}` resume。`permission.resolved` / `question.answered` 也会持久化并在恢复流中先于 `run.resumed` 出现。 |

## 用户侧操作

| 状态 | 任务 | 备注 |
|---|---|---|
| [ ] | 轮换泄露过的 AWS key。 | 这是账号侧操作，代码无法代做。 |
| [ ] | tu-zi 图像令牌分组改到支持图片的分组。 | 后台账号侧配置。 |
| [ ] | GitHub Release 草稿 review / publish。 | 先处理发布标签与 main 对齐，再发布。 |

## 暂缓项

| 事项 | 处置 |
|---|---|
| macOS 签名公证 | 暂缓。需要 Apple Developer 账号和完整 notarization 流程，非当前阻塞。 |
| Windows 代码签名 | 暂缓。未签名会受 SmartScreen 影响，但可等分发链路稳定后处理。 |
| 移动端 App | 暂缓。本地 harness 跑在用户机器上，全移动端是另一条产品线。 |
| 会话分享/协作 | 先做产品决策。本地优先隐私模型天然不适合默认分享链接。 |
| 订单退款/取消 admin 动作 | 暂缓。当前 admin 订单保持只读，符合运维边界。 |
| 细粒度 admin RBAC | 暂缓。当前单一 admin 角色足够早期运营。 |
