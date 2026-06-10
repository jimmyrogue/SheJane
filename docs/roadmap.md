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
| [ ] | web 工具循环可中断：Stop 按钮需要能 abort `runCloudToolLoop`。 | 现在 Stop 主要认 local run，web 上长循环停不下来，用户只能关页面。 |
| [ ] | web 循环恢复兜底：打开会话时把无主 `streaming` 消息标记失败。 | 浏览器标签页关闭后没有 daemon 恢复，IndexedDB 会留下永久 streaming 消息。 |
| [ ] | `hitStepCap` 给用户提示。 | web loop 撞 5 步上限时现在用户无感知，看起来像模型突然停了。 |

## P1：成本与契约

| 状态 | 任务 | 为什么 |
|---|---|---|
| [ ] | prompt caching 全链路梳理。 | daemon 已有 Anthropic cache_control 能力，但 web/cloud loop 仍可能每轮重发全量 history，成本会被放大。 |
| [ ] | token 估算改进。 | `len/4` 没算工具定义、参数和 reasoning，工具密集轮会系统性少计费。 |
| [ ] | web / daemon 工具 schema 单一来源。 | `WEB_TOOL_DEFINITIONS` 仍是手抄 daemon 工具 schema，长期一定漂移。 |
| [ ] | run 级链路追踪。 | daemon 到 API 的每轮调用现在是独立 request_id，排查一个 run 的完整路径不够顺。 |
| [ ] | 真 HTTP 契约测试覆盖 web cloud tool loop。 | 现在主要靠单测 fake，最容易漏 wire shape 和 SSE 细节。 |

## P2：生产运维硬化

| 状态 | 任务 | 为什么 |
|---|---|---|
| [ ] | Go API 换带超时的 `http.Server` 并支持优雅关闭。 | 裸 `ListenAndServe` 在部署重启时容易丢在途请求。 |
| [ ] | 安全响应头：HSTS、CSP、X-Frame-Options、X-Content-Type-Options。 | 现在 Caddy 和 Go 都没有统一设置，生产 Web 面暴露不够硬。 |
| [ ] | 生产弱默认密钥 fail-fast。 | `JWT_SECRET`、`CONFIG_ENCRYPTION_KEY` 等只 WARN 不够，生产误配会拖到运行时才爆。 |
| [ ] | 数据库迁移版本表。 | 现在迁移偏全量重放和幂等 SQL，缺少明确版本状态和回滚边界。 |
| [ ] | 镜像签名、SBOM、漏洞扫描。 | 对外发布和服务器部署需要可追踪供应链。 |
| [ ] | 修 nightly external smoke 配置。 | `STRIPE_WEBHOOK_SECRET` 等 secret 缺失会让金丝雀自己红。 |

## P3：产品体验

| 状态 | 任务 | 为什么 |
|---|---|---|
| [ ] | 跨设备会话同步方案。 | 现在聊天只在 IndexedDB，本地优先没问题，但 web/桌面互不可见。 |
| [ ] | web 文档问答与工具组合策略。 | 带附件和带工具的路径还没有统一的产品约束，容易出现能力互斥或用户困惑。 |
| [ ] | client 对 429 做专门处理。 | 服务端 spend 限流已经有了，前端需要 retry-after 和清晰提示。 |
| [ ] | 多文件附件。 | 当前附件模型偏单文档，复杂资料任务会被卡住。 |
| [ ] | Artifact 面板升级。 | 现在预览能力够用但不够像成品：代码高亮、HTML/SVG/Markdown 渲染、复制和下载还可增强。 |
| [ ] | MCP / Skills 在 UI 内增删改。 | 现在主要是浏览和开关，复杂配置仍要手改文件。 |
| [ ] | 键盘快捷键与帮助面板。 | 长时间使用时，聚焦输入、切会话、停止、搜索这些操作应该更快。 |
| [ ] | Electron 主进程中文串接入 i18n。 | 英文用户仍可能看到中文系统弹窗。 |

## P4：Agent 引擎深度

| 状态 | 任务 | 为什么 |
|---|---|---|
| [ ] | 上下文管理调优，化解 40 轮硬截断和 deepagents 压缩器的重复处理。 | 长任务可能在压缩前就丢关键上下文。 |
| [ ] | 长期记忆升级：语义检索、LLM 事实抽取、namespace 隔离。 | 现在更像 append-only 记录和子串匹配，召回质量有限。 |
| [ ] | 验证回环。 | critic / tool-critic 能评分，但低分不会自动触发有上限的重做。 |
| [ ] | 错误分类和退避策略。 | 瞬时错误、用户可修错误、致命错误需要不同处理和文案。 |
| [ ] | browser.task 接通或下架。 | 如果仍是 stub，就不要继续广告给模型。 |

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
