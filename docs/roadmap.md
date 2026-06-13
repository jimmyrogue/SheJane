# SheJane Roadmap

> 更新日期：2026-06-13
>
> 结构约定：**未完成的事项按优先级 P0 → P4 排在前面**，每项附实现思路与参考方向；已完成的事项收在文末「已完成存档」，作为实现记录保留。完成一项就把它移到存档，避免双份状态。
>
> 本次优先级吸收了 2026-06-13 与现代 agent harness（Claude Code / Codex CLI / Cursor）的能力对标结论：P1 = 高收益低成本（基建现成），P2 = 中收益跟进，P4 = 高成本战略投资。

## 当前事实

- 旧 P0/P1/P2 主线已经完成：CI 修复、充值入口、欢迎页磁贴、安全与计费护栏、监控探针、自动备份、Stripe webhook 原子化、P2 体验功能和质量测试都已落地。
- 模型选择已经切到 **Auto 意图 + 后台模型目录**。用户端始终有 `Auto`，并提供 `更快` / `更强` 两个 Auto 意图（wire 值 `auto.fast` / `auto.smart`），具体模型页按厂商显示后台启用的 chat 模型，厂商名后的 info 图标展示后台 `vendor_info` 厂商简介。管理员用「模型 ID + 显示名 + 厂商 + 厂商简介 + 能力档位 + provider_kind + key + base_url + model_name + 输入/输出 token 费率」配置模型；数据库字段仍叫 `slot`，只是历史字段名。
- `chat.fast` / `chat.deep` 仍作为种子模型 ID 保留，保证老配置可用；它们不再代表固定的产品层级。新的 chat 模型 ID 可以是 `gpt-4o`、`claude-sonnet`、`deepseek-v4` 等。
- `Auto` 由 Go API 统一解析：`POST /api/v1/models/resolve` 在 run 开始时从 enabled chat 模型里选一个，并发出 `model.selected`。中性 `auto` 按用户问题难度映射到 `fast` / `balanced` / `reasoning` / `max`；`auto.fast` 优先 `fast/balanced`，`auto.smart` 优先 `reasoning/max`，再扣入最近 LLM 调用失败率/延迟和 token 费率；`/agent/llm/stream` 遇到上游模型失败会按同一排序降级一次并再次发出 `model.selected`。daemon、本地 run、web cloud tool loop 都只传 Auto sentinel 或具体模型 ID。
- image 模型不进入聊天选择器。当前 resolver 只支持 `image.default`，后台也只允许 image capability 使用这个模型 ID。
- 平台付费 provider key 仍只在 Go API 侧使用。后台模型配置可以写入 provider key，但 key 加密存储且不回显；daemon 不读取这些 key。
- Local Host 已支持本机定时 run：`local_scheduled_runs` 存 SQLite，daemon 内置 dispatcher 到点复用普通 `RunCoordinator.start_run()`，Electron 轮询 completed/failed schedule 后发系统通知并标记已提醒。当前只做本机最小版，不做云端推送或跨设备同步。
- Web / desktop composer 已支持一次附加多个上传文档；cloud agent run 会把 `attachments[]` 中每个 document 逐个读取并注入同一轮文档上下文。当前仍不做向量库或团队文档库。
- 附件与工具组合策略已明确：上传文档走 document-grounded Q&A，不与 web search、image generation、code execution、本地项目工具、MCP 或 Skills 在同一 turn 混用；composer 在有附件且工具入口可用时显示「附件模式」状态。
- 用户端已支持核心全局快捷键：`Cmd/Ctrl+N` 新建对话、`Cmd/Ctrl+K` 打开并聚焦会话搜索、`Esc` 停止当前任务或关闭快捷键面板、`?` 打开快捷键帮助。
- Electron 主进程文案已接入桌面端共享 locale 资源：menu、daemon 错误弹窗、workspace 选择弹窗和 auth bridge generic error 统一走 `client/shared/desktop-i18n.json`；启动时优先读取上次 renderer 写入的 locale，没有记录时按系统语言归一到 zh/en。
- Release workflow 已对 GHCR 镜像增加供应链守门：Trivy HIGH / CRITICAL 漏洞扫描作为签名前 gate，Syft 生成 SPDX JSON SBOM 并附到 tag 的 GitHub Release，Cosign 使用 GitHub OIDC keyless 签名镜像 digest。
- Nightly External Smoke 在 GitHub Actions 中会对缺失 secret 显式降级：缺 `SHEJANE_API_BASE_URL` 跳过整套并写 warning / job summary，缺 `STRIPE_WEBHOOK_SECRET` 只跳过 Stripe webhook smoke，避免金丝雀因未配置 secret 直接红掉。
- 文档入口收敛为 `CLAUDE.md`、`AGENTS.md`、`docs/run-loop.md`、`docs/client-sse-protocol.md`、`docs/document-tool-policy.md`、`docs/self-correction-stack.md`、`docs/operations.md`、本路线图。旧 status 快照、旧模型目录设计稿、旧 Node 架构图和 Phase 0 spike 报告已删除。
- 发布标签已对齐：`v0.1.9`（`3438f02`）包含生图重复回复修复（`3ec14c7`）和可配置模型目录（`1ff449d`）；main 仅领先一个 UI polish 提交（`151ec96`），下次打 tag 带上即可。
- 2026-06-13 harness 对标结论：HITL 权限、checkpoint/恢复、MCP 多源发现、Skills、中间件式自我纠错栈（plan-first / tool-critic / verification-loop / progress-ledger）已对齐甚至领先现代 harness；多 provider 模型目录和 Reserve→Settle 计费是参照物没有的差异化资产。主要缺口（mid-run steering、计划审批、subagent 配置化、语义摘要/记忆、Auto 可靠性路由）已按收益 × 难度编入下面的 P1/P2/P4。

## P0：发布与部署守门

当前暂无可在本地代码仓库内完成的 P0 任务。服务器部署后验证已在本轮执行中跳过，记录见「本轮执行记录」。

## P1：高收益低成本的 harness 能力（基建现成，建议本周期内做）

当前暂无未完成的 P1 任务。本轮已完成 #1-#4，记录见「本轮执行记录」。

## P2：中收益跟进（第一梯队完成后）

当前暂无未完成的 P2 任务。本轮已完成 #5-#11，记录见「本轮执行记录」。

## P3：运维硬化与产品补全

当前暂无未完成的 P3 任务。本轮已完成运维硬化与产品补全项，记录见「本轮执行记录」。

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

## 本轮执行记录

| 优先级 | 任务 | 结果 | 记录 |
|---|---|---|---|
| P0 | 服务器部署后验证 | 跳过 | 需要真实服务器部署路径、目标机器会话和生产/预发环境凭证；当前仅有本地仓库上下文，不能可靠执行 `make deploy` 后的线上 wire contract 验证。后续拿到部署环境后再按 `docs/operations.md` 清单补跑，并可沉淀 `make smoke-deploy`。 |
| P1 #1 | Mid-run steering：运行中追加用户指令 | 成功 | daemon 新增 `POST /local/v1/runs/{run_id}/inject`，把追加指令写入 `local_steering` SQLite 队列；`SteeringMiddleware.abefore_model` 在下一次模型调用前 claim pending 指令并以用户消息注入上下文，同时发 `steering.injected` SSE；client local-host helper、Composer active-run「追加指示」模式和 timeline 文案已接入。验证：`make schemas`、`uv run python -m pytest tests/test_steering.py -q`、`npm test -- --run src/shared/local-host/client.test.ts src/features/chat/components/Composer.test.tsx src/features/chat/chatStore.test.ts`。 |
| P1 #2 | 计划审批模式（Plan Mode） | 成功 | `PlanApprovalMiddleware` 在 plan-first 模式下拦截 `write_todos`，以 `kind=plan_approval` interrupt 暂停在工具执行前；daemon 持久化 `local_plan_approvals`，发 `plan.approval_required` / `plan.approval_resolved`，并通过 `POST /local/v1/plans/{approval_id}` 支持批准、要求修改或拒绝。client 新增计划审批 dock、pending finder、timeline 字段和 local-host helper；批准放行原计划，修改/拒绝会把原 tool call 转成反馈给模型并跳过同批未审批工具。验证：`make schemas`、`uv run python -m pytest tests/test_plan_approval.py tests/test_runs_http.py::test_plan_approval_resolution_emits_event_and_resumes -q`、`npm test -- --run src/shared/local-host/client.test.ts src/features/chat/chatStore.test.ts src/features/chat/pendingPlanApproval.test.ts src/features/chat/components/PendingPlanApprovalBar.test.tsx`、`cd client && npm run build`。 |
| P1 #3 | Artifact 面板升级 | 成功 | `ArtifactPanel` 从纯文本 `<pre>` 升级为格式感知视图：Markdown 用 `react-markdown` + GFM/breaks 渲染并复用 `CodeBlock` 高亮，HTML/SVG 进入无权限 sandbox iframe，JSON/代码按扩展名走高亮代码块；header 增加复制、下载、关闭 icon 操作，面板宽度从窄栏扩到 720px 以便阅读产物。验证：`npm test -- --run src/features/chat/components/ArtifactPanel.test.tsx src/features/chat/components/MessageBubble.test.tsx`、`cd client && npm run build`、in-app Browser 打开 `http://127.0.0.1:5173/` smoke（标题「石间 SheJane」，无 console error）。 |
| P1 #4 | subagent 配置化 | 成功 | `agent/subagents.py` 从硬编码列表升级为“内置 researcher/writer + Markdown 配置”组合：默认扫描 `~/.shejane/agents/*.md`，也支持 `SHEJANE_LOCAL_AGENTS_PATH` 完整覆盖；每个文件用 frontmatter 声明 `name`、`description`、`tools` 白名单，正文作为 subagent system prompt，同名配置可覆盖内置项。`docs/operations.md` 已补文件格式与工具白名单说明，`pyyaml` 作为 Local Host 直接依赖写入 lockfile。验证：先红后绿 `uv run python -m pytest tests/test_subagents.py -q`，以及 `uv run ruff check local_host/agent/subagents.py tests/test_subagents.py --fix`。 |
| P2 #5 | checkpoint fork：从检查点重试 | 成功 | daemon 新增 `POST /local/v1/runs/{run_id}/fork`，接收 `checkpoint_id` 后为新 run 创建独立 thread_id，并把源 run 指定 checkpoint 及其 parent 链、pending writes 从 LangGraph SQLite checkpointer 复制到新 thread；新 run 继承源 workspace/settings/model，metadata 标记 `intent=checkpoint_fork`、源 run 和源 checkpoint。client 新增 `forkLocalRun` helper，诊断面板的最新检查点旁提供「从这里重试」按钮，点击后在当前会话追加 fork run 并自动 stream。验证：`make schemas`、`uv run python -m pytest tests/test_runs_http.py::test_fork_run_missing_checkpoint_returns_404 tests/test_runs_http.py::test_fork_run_from_checkpoint_creates_child_thread -q`、`uv run ruff check local_host/runs.py local_host/server.py local_host/api_schemas.py tests/test_runs_http.py`、`npm test -- --run src/shared/local-host/client.test.ts src/features/chat/components/DiagnosticsPanel.test.tsx`、`cd client && npm run build`。 |
| P2 #6 | Extended thinking 统一适配 | 成功 | Go Anthropic provider 新增可选 `AnthropicProviderOptions`，支持从后台模型 `params` 配置 `thinking_type`、`thinking_budget_tokens`、`thinking_display`、`thinking_effort`；手动 `enabled` 会发送 `budget_tokens`，`adaptive` 会发送 `thinking:{type:"adaptive"}` 并把 effort 放入 `output_config`。流式 `thinking_delta` 和非流式 `thinking` block 都解析到统一 `ReasoningContent`，agent SSE 层会把 reasoning-only chunk 写成现有 `llm.delta.reasoning_delta`，daemon/client 沿用原 `llm.reasoning` 路径。验证：先红后绿 `go test ./internal/llm -run 'TestAnthropic(CompleteWithToolsIncludesThinkingAndParsesReasoning|StreamEnablesAdaptiveThinkingAndEmitsReasoning|CompleteWithToolsRoundTrip|StreamReportsInputTokensAndMaxTokens)'`、`go test ./internal/httpapi -run TestRunAgentLLMStreamEmitsReasoningOnlyChunks`。 |
| P2 #7 | MCP / Skills 在 UI 内增删改 | 成功 | daemon 新增 SheJane 自有配置源 CRUD：`POST/PUT/DELETE /local/v1/mcp-servers` 写 `~/.shejane/mcp-servers.json`，`POST/GET/PUT/DELETE /local/v1/skills/{name}` 写 `~/.shejane/skills/<name>/SKILL.md`；外部 Claude Desktop / Cursor / Codex / `.claude/skills` 来源保持只读。client 新增 local-host helper、MCP inline server 表单（stdio command+args / URL）和 Skills `SKILL.md` 编辑器，只有 `source=shejane` 行显示编辑/删除。验证：先红后绿 `uv run python -m pytest tests/test_mcp.py::test_http_mcp_server_crud_writes_only_shejane_config tests/test_skills.py::test_http_skill_crud_writes_personal_skill -q`、`make schemas`、`uv run python -m pytest tests/test_mcp.py tests/test_skills.py -q`、`npm test -- --run src/shared/local-host/client.test.ts src/features/mcp/MCPView.test.tsx src/features/skills/SkillsView.test.tsx`、`cd client && npm run build`；Browser harness smoke：Skills 表单可打开，MCP 页面/行操作渲染且无 console error，截图与 MCP click 因 Browser 后端 CDP 超时未完成。 |
| P2 #8 | web cloud tool loop 步数上限策略 | 成功 | Go API 新增 `WEB_TOOL_LOOP_MAX_STEPS`（默认 5，夹在 1-50）并通过 `/api/v1/agent/tool-capabilities` 下发 `web_tool_loop_max_steps`；web client 按该值分段运行 browser-orchestrated cloud tool loop。触顶时不再直接 done，而是在同一 assistant message 里写入 `run.budget_warning` + `question.asked`，复用现有输入框上方 question card 显示「继续 N 步？」；确认后用同一 `runId`、保存的模型/工具 history 和后续 Reserve/Settle 计费继续下一段，跳过则保留已有结果并结束。验证：先红后绿 `go test ./internal/config -run TestLoadWebToolLoopMaxSteps`、`go test ./internal/httpapi -run TestAgentToolCapabilitiesRequireAuthAndHideUnconfiguredTavily`、`npm test -- --run src/shared/cloudAgentLoop.test.ts src/shared/api/client.test.ts src/features/chat/chatStore.test.ts`、`cd client && npm run build`。 |
| P2 #9 | Auto 路由升级：可靠性/成本信号 + run 内降级 | 成功 | Auto 候选不再只按后台 priority：Go API 会读取最近 30 分钟最多 500 条 `llm_call_records`，按模型 ID 统计失败率/平均延迟，并结合输入/输出 token 费率给候选扣分；空目标兜底、classifier prompt 顺序和上游失败后的下一候选都复用同一排序。`/api/v1/agent/llm/stream` 首选模型失败时会 release 原 reservation、把原 LLM call 记为 `failed`，再 reserve 下一候选并重跑一次；降级通过 `llm.model_selected` 映射成前端现有 `model.selected`，避免静默换模。验证：先红后绿 `go test ./internal/app -run 'TestResolveAutoModel(RanksByRecentHealthAndCost|CanChooseArbitraryCatalogID|ClassifiesAndFallsBack|SingleCandidateSkipsClassifier)'`、`go test ./internal/httpapi -run 'TestAgentLLMStream(FallsBackToNextCandidateOnProviderFailure|EmitsDeltaUsageAndDoneAndSettlesCredits|EmitsReasoningOnlyChunks)'`、`npm test -- --run src/shared/api/sse.test.ts src/shared/api/client.test.ts`。 |
| P2 #9 后续 | 模型目录厂商分组 + Auto 难度分层 | 成功 | 模型配置新增 `vendor`、`vendor_info` 与 `capability_tier`（`fast` / `balanced` / `reasoning` / `max`）并通过迁移、memory/Postgres store、admin API、`GET /models` 全链路透出；用户端模型选择器改为 Auto 置顶、按厂商分组展示 enabled chat 模型，厂商名后的 info 图标悬浮展示后台厂商简介，后台模型配置表单/列表可编辑并展示厂商和档位。后端基于 OpenRouter 使用量与强模型线索补齐默认停用模板：DeepSeek V4 Flash/Pro、Mimo V2.5、MiniMax M3、GPT-5.5、Claude Opus 4.8、Kimi K2、Qwen3 Coder、Gemini 3.1 Pro。Auto 解析先按用户目标难度筛选能力档位，再复用现有健康/成本/priority 排序和 classifier；空目标仍保持原默认模型逻辑。后续补入用户端 `更快` / `更强` Auto 意图：`auto.fast` 优先 `fast/balanced`，`auto.smart` 优先 `reasoning/max`，不静态绑定具体模型。验证：`go test ./internal/store ./internal/modelreg ./internal/app ./internal/httpapi ./internal/dbmigrations`、`npm test -- --run src/features/chat/components/ModeSelector.test.tsx src/App.test.tsx`、`cd admin && npm test -- --run src/App.test.tsx src/shared/api/client.test.ts`、`make test`、`make build`、`git diff --check`、Browser harness smoke 打开模型菜单并选择 Mimo。 |
| P2 #10 | 定时任务与结果通知 | 成功 | Local Host 新增 `local_scheduled_runs` SQLite 表、`ScheduledRunDispatcher` 和 `GET/POST/DELETE /local/v1/schedules` / `/notified` API。dispatcher 每 5 秒 claim 到期 schedule，复用普通 `RunCoordinator.start_run()` 创建本地 run，并主动消费 stream 防止后台任务无人 drain 时堵住队列；完成后写 `result_text`，失败写 `error_message`，等待权限/输入会作为需要人工介入的 failed schedule 暴露。client 新增 local-host schedule helper，Electron renderer 轮询 `notify_pending=true` 后复用系统通知桥提醒结果并回写 notified。验证：先红后绿 `uv run python -m pytest tests/test_scheduled_runs.py`、`make schemas`、`npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`。 |
| P2 #11 | 多文件附件 | 成功 | Composer 支持一次选择/拖入多个文件并渲染多个附件 tile；App 按文档 ID 维护多附件和预览，发送 cloud agent run 时把多个上传文档写入 `documents` / `attachments[]`，删除或回滚时按单个文档清理。Go agent run API 原本已接收 `attachments[]`，本轮补充双文档 stream 回归测试，确认每个文档都会触发 `document.read` 并注入同一轮文档上下文；`docs/operations.md` 已把单文件边界更新为多文件上下文边界。验证：`npm test -- --run src/features/chat/chatStore.test.ts src/features/chat/components/Composer.test.tsx src/App.test.tsx`、`go test ./internal/httpapi -run 'TestAgentRunWith(DocumentAttachment|MultipleDocumentAttachments)EmitsDocumentToolEvents'`、`cd client && npm run build`。 |
| P3 | 镜像签名、SBOM、漏洞扫描 | 成功 | `.github/workflows/release.yml` 在现有 api/client/admin 多架构 GHCR 发布矩阵后增加供应链步骤：按 build digest 准备统一 image ref，先用 Trivy 扫描 OS/library HIGH / CRITICAL 漏洞并以 `exit-code=1` 作为 gate；通过 Anchore Syft 生成每个镜像的 SPDX JSON SBOM，保存 workflow artifact，并在 tag workflow 中确保同名 GitHub Release 存在后上传 SBOM；最后用 Cosign + GitHub OIDC keyless 签名所有发布 tag 对应的 manifest digest。`docs/operations.md` 已补发布验证边界。验证：`ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml")'`、`go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/release.yml`、`git diff --check`。 |
| P3 | 修 nightly external smoke 配置 | 成功 | `scripts/smoke-external.sh` 新增 GitHub Actions 预检与显式 skip：在 Actions 中缺 `SHEJANE_API_BASE_URL` 时整套 external smoke 退出 0 并写 `::warning` / job summary；缺 `STRIPE_WEBHOOK_SECRET` 时只跳过 Stripe webhook smoke，real LLM 与 S3 document smoke 仍继续；也提供 `SKIP_REAL_LLM_SMOKE` / `SKIP_STRIPE_WEBHOOK_SMOKE` / `SKIP_S3_DOCUMENT_SMOKE` 便于手动隔离。`.github/workflows/external-smoke.yml` 去掉硬失败的 `test -n "$API_BASE_URL"`，`docs/operations.md` 已补 skip 语义。验证：`bash -n scripts/smoke-external.sh`、模拟 GitHub Actions 缺 API URL / 缺 Stripe secret 两个场景、`ruby -e 'require "yaml"; YAML.load_file(".github/workflows/external-smoke.yml")'`、`go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/external-smoke.yml`、`git diff --check`。 |
| P3 | web 文档问答与工具组合策略 | 成功 | 新增 `docs/document-tool-policy.md`，明确附件 × 工具矩阵：纯文本可走 web/cloud/local tools；上传 PDF/DOCX/XLSX 进入 document-grounded Q&A，多个文档注入同一个上下文，但本 turn 不混用 web search、image generation、code execution、本地项目工具、MCP 或 Skills；图片附件仍保留 Local Host image-edit 路径。Composer 在有附件且工具入口可用时显示紧凑「附件模式」状态 chip，tooltip 说明本 turn 暂停网页/图片工具；dev harness 增加 `?attachment=1` 便于 UI QA。验证：`npm test -- --run src/features/chat/components/Composer.test.tsx`、`cd client && npm run build`、Browser 打开 `http://127.0.0.1:5174/harness.html?view=chat&attachment=1`，确认页面标题、DOM 中唯一「附件模式」状态、tooltip、输入交互和移动宽度状态均正常且 console 无 error/warn；Browser 截图接口两次因 CDP `Page.captureScreenshot` 超时未产出截图。 |
| P3 | 键盘快捷键与帮助面板 | 成功 | App 全局快捷键扩展为 `Cmd/Ctrl+N` 新建对话、`Cmd/Ctrl+K` 展开侧栏并聚焦会话搜索、`Esc` 关闭快捷键面板或停止当前可取消 run、`?` 打开快捷键帮助面板；输入框/可编辑区域不会触发 `?` 帮助。`ConversationSidebar` 新增受控 `searchRequestVersion`，复用现有搜索 UI；帮助面板复用 shadcn Dialog，以动作 + `kbd` 键位列表展示。验证：`npm test -- --run src/App.test.tsx`、`cd client && npm run build`、`git diff --check`、Browser 重新加载 `harness.html?view=chat&attachment=1` 确认页面无 console error/warn。 |
| P3 | Electron 主进程中文串接入 i18n | 成功 | 新增 `client/shared/desktop-i18n.json` 作为 Electron main/preload 与 renderer 可共享的桌面文案资源，`client/electron/desktop-i18n.cjs` 负责 locale 归一、模板插值和文案读取；menu、daemon 错误弹窗、workspace 选择弹窗与 auth bridge generic fallback 都改为读取共享文案。启动 locale 改为优先使用 renderer 之前写入的 dock-lang，没有记录时读取系统 locale（`en-US` 等归一为 `en`，其余归一为 `zh`）。`electron-builder.yml` 已把 `shared/**/*` 纳入 asar。验证：`npm test -- --run electron/menu.test.ts src/shared/api/electronAuthBridge.test.ts`、`node -e "const i18n=require('./client/electron/desktop-i18n.cjs'); console.log(i18n.normalizeDesktopLocale('en-US'), i18n.desktopText('en-US','dialogs.selectWorkspaceTitle'))"`、`rg` 确认主进程中文只剩共享资源和测试断言、`cd client && npm run build`。 |
| P3 | 中间件自我纠错栈对外文档化 | 成功 | 新增 `docs/self-correction-stack.md`，把 plan-first、计划审批、tool critic、verification loop、progress ledger 和 reflect 从内部时序图整理成面向用户/评估者的能力说明，覆盖触发点、配置开关、用户可见信号、边界和关键源码；`docs/run-loop.md` 与 `docs/operations.md` 已补入口链接。验证：人工核对 `docs/run-loop.md` 中间件矩阵、`local-host/python/local_host/middleware/*.py` docstring 和 `local-host/python/local_host/agent/builder.py` 装配顺序。 |
| P4 | 语义摘要 + 语义记忆（共享 embedding 基建） | 跳过 | 本轮可行性核对后未实施：当前只有确定性历史摘要、workspace namespace 隔离、显式 `user_fact` 和 keyword/recency `memory.search`；完整 P4 需要新增云端 embedding/model registry 能力、Reserve/Settle 计费、Local Host 向量索引启用、LLM compact 策略、事实抽取/合并/过期验证和迁移测试，无法在一次线性清单执行中安全完成。该项保留在 P4 backlog，下一步应先拆成 embedding 网关 + 语义 memory MVP + LLM compact 三个可验收子任务。依据：`rg embedding/vector/semantic/memory.search/max_history_turns`、`docs/run-loop.md`、`docs/operations.md`、`local-host/python/local_host/tools/memory.py`。 |
| P4 | 失败后的一键恢复工作流（统一 orchestrator） | 跳过 | 本轮可行性核对后未实施：现有 retry/repair/quota/auth/workspace 已有入口、metadata、per-target in-flight guard 和观察器，但统一 orchestrator 会改动失败分类、UI recovery target、钱包/session/workspace 前置条件、确认流与 run 重启编排，跨 client、daemon 和测试面较大；仓促合并会比现状的显式按钮更容易造成误重跑。该项保留在 P4 backlog，建议先写状态机 spec，再按一个 category 一次迁移。依据：`rg retry/repair/recovery/failure/action_kind`、`docs/run-loop.md`、`docs/operations.md`、`client/src/App.tsx`、`client/src/features/chat/components/AgentProgress.tsx`。 |
| P4 | 跨设备会话同步 | 跳过 | 本轮可行性核对后未实施：当前产品边界明确为聊天正文 local-first，后端只存 usage metadata、billing、run 摘要和审计；跨设备同步需要先决定是否同步完整消息、是否端到端加密、冲突解决、删除/导出语义和本地 run 工件边界。该项不是纯工程缺口，继续保留在 P4 backlog，产品决策完成后再做 schema/API/client sync 设计。依据：`rg conversation/messages/IndexedDB/local-first/sync/encrypt`、`AGENTS.md`、`docs/operations.md`、`client/src/shared/local-data`。 |

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
