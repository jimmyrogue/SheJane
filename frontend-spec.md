# 简单（Jiandan）前端技术方案

**版本：** v1.3
**更新：** 2026-05-11
**适用阶段：** Phase 1-5 分阶段落地

> 本文档补充 `project-plan.md`、`backend-spec.md` 与 [`spec.md`](spec.md) 中缺失的前端客户端设计。前端采用 Hybrid Local-first：长期聊天历史和个人工作数据默认保存在客户端，本地体验先闭环，并从 Phase 2 起演进为统一 Agentic Chat 与 Local Agent Harness。

---

## 一、前端定位

### 1.1 产品目标

前端不是模型管理器，也不是纯聊天壳，而是面向非技术用户的统一 Agentic Chat 工作台：

- Phase 1：注册登录、基础聊天、本地聊天历史、快速/深度模式、额度展示、订阅入口
- Phase 2：统一 composer、附件自动解析、云端兼容 Agent Run、事件流、文档/网页工具
- Phase 2.3：Local Agent Harness daemon foundation，Electron 能探测本地 Host 并显示本地/云端受限状态
- Phase 2.4+：Harness Loop、本地文件引用、本地 MCP、受控 shell/浏览器/IDE 工具
- Phase 4：Office/图片生成、多工具编排、artifact、上下文压缩、checkpoint 和任务恢复
- Phase 5：团队管理后台、共享知识库、自动化工作流、开放平台 API

### 1.2 客户端形态

| 客户端 | 能力边界 | 说明 |
|--------|----------|------|
| Web | 云端 API、Agentic Chat、本地 IndexedDB、临时文件上传、支付 | 不执行本地工具；Local Harness 离线时使用云端受限模式 |
| Electron | Web 全部能力 + Local Harness 探测 + 本地 SQLite / 文件数据库 | Phase 2.3 起探测 Host；Phase 2.4+ 承担本地工具执行与权限 UI |
| PWA / Capacitor | Phase 5 之后评估 | 只复用核心业务能力，不优先承载本地工具 |

### 1.3 核心原则

- **共享优先**：Web 与 Electron 共享 80%+ React 组件、状态和 API client。
- **本地优先**：长期聊天历史、搜索、导入/导出和个人工作数据默认由客户端保存。
- **桌面增强**：Electron / Local Agent Harness 承载 Web 无法安全完成的本地能力。
- **权限显式**：本地文件、浏览器、电脑控制类工具必须由用户确认。
- **账务一致**：所有模型与工具消耗都走后端钱包预留/结算，前端只展示状态。
- **简单默认**：MVP 不出现模型、token、API key、供应商配置等概念。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                 React Shared App                         │
│  Routes / Components / Stores / API / SSE / Local Data   │
└───────────────┬───────────────────────────┬─────────────┘
                │                           │
                ▼                           ▼
┌──────────────────────────┐      ┌────────────────────────┐
│ Web Runtime              │      │ Electron Runtime       │
│ Browser APIs only        │      │ Main + Preload + IPC   │
│ IndexedDB local history  │      │ SQLite / file database │
│ Cloud-limited Agent      │      │ Local Agent Harness    │
└───────────────┬──────────┘      └─────────────┬──────────┘
                │ HTTPS / SSE                   │ HTTPS / SSE + IPC
                └───────────────┬───────────────┘
                                ▼
┌─────────────────────────────────────────────────────────┐
│                 Go API Gateway                           │
│ Auth / Billing / LLM Proxy / Temporary File / Share      │
└─────────────────────────────────────────────────────────┘
```

### 2.1 推荐项目结构

```text
jiandanly-client/
├── src/
│   ├── app/                 # 路由、布局、全局 provider
│   ├── features/
│   │   ├── auth/            # 登录、注册、刷新会话
│   │   ├── chat/            # 对话、SSE、本地消息列表
│   │   ├── billing/         # 额度、订阅、充值入口
│   │   ├── conversations/   # 本地列表、搜索、分享快照、导出
│   │   ├── composer/        # 统一输入、附件、URL、本地引用
│   │   ├── files/           # 上传、确认、文件状态；作为 Agent 工具输入
│   │   ├── personal/        # 个人文件库、个人知识库、用量历史
│   │   ├── team/            # Phase 5 团队后台
│   │   ├── settings/        # 账号、安全、偏好
│   │   └── agent/           # Agent run、事件流、工具状态、权限请求
│   ├── shared/
│   │   ├── api/             # REST client、SSE client、错误处理
│   │   ├── local-data/      # IndexedDB / SQLite adapter、导入导出
│   │   ├── ui/              # 基础组件
│   │   ├── store/           # 全局状态
│   │   └── utils/
│   └── main.tsx
├── electron/
│   ├── main.ts              # 窗口、菜单、更新、本地能力调度
│   └── preload.ts           # 暴露本地 Host 地址等安全 metadata
├── local-host/              # Node/TypeScript Local Agent Harness daemon
│   └── src/
│       ├── server.ts        # loopback API、pairing token、SSE
│       ├── tools/           # typed tool registry
│       └── state/           # SQLite / test store
└── package.json
```

---

## 三、核心模块

### 3.1 Auth

- Access Token 存前端内存，Refresh Token 使用 HTTPOnly Cookie。
- 启动时调用 `/api/v1/auth/refresh` 恢复会话。
- 登录态失效时清空本地业务状态并跳转登录页。
- 前端不保存供应商 API key，不提供 BYOK 设置入口。
- 登出不默认删除本地聊天历史；设置页提供“清空本地数据”。

### 3.2 Local Data / 数据所有权

- Web 使用 IndexedDB 保存本地 conversations、messages、drafts、attachments index、prompt favorites。
- Electron 使用本地 SQLite 或文件数据库保存同等数据，并预留加密和备份能力。
- 后端返回的 `request_id`、token、credits、status 写回本地消息 metadata，正文仍由本地数据库持久化。
- 导入 / 导出优先支持 JSON 和 Markdown；导出文件由客户端生成。
- 云端历史、跨设备自动同步、云知识库都属于后期 opt-in 能力，默认关闭且不进入 Phase 1 MVP。

### 3.3 Chat / SSE

- Phase 1 只支持基础文本聊天和 `fast` / `deep` 模式。
- SSE client 负责解析 OpenAI-compatible stream，并把增量内容写入当前 assistant message。
- 发送前先在本地创建 `client_conversation_id`、user message 和空 assistant message，再把 `client_conversation_id` / `client_message_id` 随请求发给后端。
- 客户端断线后保留已收到的本地增量内容，允许用户手动重试；真正可靠恢复从 Phase 2.2 的 Agent Run events 开始补齐。
- 发送前展示额度不足、未登录等明确错误；团队钱包错误只在 Phase 5 出现。

### 3.4 Billing

- 展示本月额度、额外额度、预计可用次数、订阅状态。
- 包月订阅通过后端 Checkout URL 跳转 Stripe。
- 额外额度包只作为月额度耗尽后的补充购买入口。
- 支付完成后回到前端 success 页面并轮询后端账单状态，不以前端 URL 参数直接加额度。

### 3.5 Conversation / Unified Composer

- Phase 1：本地对话列表、详情、重命名、归档/删除、导入/导出。
- Phase 2：普通聊天、附件问答、网页研究和任务 Agent 收敛到同一个 composer 与同一条 timeline。
- composer 支持文本、附件、URL，后续支持本地文件/项目引用。
- 上传附件并发送问题时，前端不再要求用户切换“文档阅读”模式，而是把附件作为本次 Agentic Chat 的输入。
- 本地全文搜索、分享快照、导出增强继续保留，但不再作为场景模板路线的一部分。
- 分享必须是显式动作：用户选择要分享的对话范围，前端上传 snapshot 到 `/api/v1/shared-conversations`。
- 分享前提醒用户链接可被访问，默认支持过期时间、撤销和脱敏检查。

### 3.6 Skill / Tool Selection

- Phase 2 不再把“场景卡片 / Prompt 模板”作为主入口。
- 前端只展示系统自动选择的 skill、工具调用和来源；用户不需要手动选择 scene。
- `fast` / `deep` 仍可作为质量/成本控制，不等同于 agent 模式切换。
- 内部可继续保留 prompt/skill 配置，但它们属于运行时能力，不是用户必须理解的产品概念。

### 3.7 File Upload

- 文件上传走 S3 预签名 URL：
  1. 前端向后端申请 upload URL
  2. 前端直传 S3
  3. 前端调用 confirm 接口
  4. 后端记录临时文件元数据并进入处理流程
- Phase 1/2 默认 `purpose=temporary_input`，后端返回 `expires_at`，前端展示临时留存提示。
- 前端限制文件类型和大小，但以后端校验为准。
- Web 与 Electron 上传逻辑共享；Electron 后续由 Local Agent Harness 增强本地文件选择、读取和权限体验。

### 3.8 Personal Workspace

- Phase 3 启用。
- 支持个人本地文件库、本地项目引用、本地 MCP 配置和用量历史。
- 所有个人能力默认绑定用户钱包，不需要选择团队上下文。
- 数据导出、删除和账号安全入口也放在个人设置中。
- 云文件库、云知识库和云同步必须用户主动开启，后期再做。

### 3.9 Team Admin

- Phase 5 启用。
- 支持组织信息、成员列表、角色、成员月上限、团队账单和团队 Agent 策略。
- 使用团队钱包时，请求必须显式带 `organization_id`，前端不能静默猜测。

### 3.10 Settings

- 账号资料、密码、安全会话、通知偏好。
- 不出现 BYOK、供应商 key、模型 provider 配置。
- 本地数据管理：查看本地占用、导入、导出、清空本地聊天历史。
- Electron 可额外显示本地权限状态，但不在 Phase 1 实现。

---

## 四、Local Agent Harness 前端路线

### 4.1 结论

Agent 能力采用 **Local Agent Harness + Cloud Control Plane**：

- 云端：模型路由、个人账本、云端文档/网页工具、兼容 run API、admin 观察与审计
- Electron / Local Harness：本地工具执行、本地 MCP、浏览器/IDE/终端权限确认、本地执行日志、checkpoint、artifact 和恢复
- Web：统一 Agentic Chat UI；Local Harness 离线时只使用云端受限能力

### 4.2 Phase 2.1 / 2.2：统一入口与云端兼容 Run

第一版 Agentic Chat 先合并现有普通聊天和 Phase 2A 文档阅读：

- 一个 composer 支持文本、附件和 URL
- 上传文件后自动走 presigned upload + complete + 文本提取
- 前端用一条 timeline 展示普通回答、文档解析状态、工具调用和最终答案
- 云端兼容 run/event/stream API 先承接 Web 体验，为 Local Harness 保持同一事件模型。Phase 2.2 已让普通问题和附件问答都走 Agent Run stream。

前端需要提供：

- Agent run timeline：目标、事件流、工具状态、取消按钮
- Tool call 卡片：工具名、输入摘要、执行状态、结果文件或来源
- 额度提示：工具执行前展示预计消耗，实际结算以后端为准

### 4.3 Phase 2.3：Daemon Foundation

Phase 2.3 先证明 Electron 能发现本地 Harness，不执行危险工具：

- `preload` 暴露 `jiandanDesktop.localHost.baseURL`。
- React 启动后只在 Electron 环境探测 `GET /local/v1/health`。
- UI 显示“本地 Harness”或“云端受限”。
- Web 环境不主动访问本地端口。
- 非 health 的本地 API 必须带 pairing token。

### 4.4 Phase 2.4：Harness Loop 与本地工具

Local Harness 是长期强能力核心：

- 本地文件读取、本地项目引用、本地 MCP、受控 shell
- Chrome / Browser Use：读取网页、点击、表单填写、下载文件
- IDE / terminal 工具：只在用户授权后执行
- 本地 run events 默认保存在本机，云端只同步计费、审计和摘要
- 大工具输出显示为 artifact，必要时再按需打开

这些能力只允许在 Electron 中开启，且必须有：

- 工具 allowlist
- 每次高风险动作前的用户确认
- 可见的执行轨迹和取消按钮
- 权限日志和审计记录
- 敏感输入遮蔽
- checkpoint / resume / cancel 状态

当前 Phase 2.9 已实现 daemon 内的 TAO loop、`time.now`、授权 workspace 内 `file.read` / `file.search`、permission-gated `shell.run`、云端 `/api/v1/agent/llm` 扣费入口、`/api/v1/agent/tool-events` 摘要入口、长输出 artifact、checkpoint resume、上下文压缩、基础本地 memory、规则验证事件、`web.fetch`、可选 Tavily `web.search` 和 MCP allowlist 护栏。普通 client 已能在 Local Host 已配对时创建本地 run，通过 Electron 原生目录选择器选择工作区，调用 Local Host 授权、诊断或撤销路径，在 timeline 中批准/拒绝权限请求、查看 artifact、展示 verification 结果，并在 composer 中显示当前本地项目引用。后续仍需要 checkpoint/resume 更细 UI、真实 MCP runtime adapter、浏览器/IDE 控制和视觉验证。

### 4.5 Electron / Local API 安全边界

```text
Renderer 不能直接访问 Node.js / 文件系统 / shell
Renderer → preload 暴露安全 metadata
Renderer → loopback Local API 通过 pairing token 调用
Local Harness supervisor → user worker 执行受控工具
```

Phase 2.3 本地 API：

| API | 阶段 | 说明 |
|-----|------|------|
| `GET /local/v1/health` | Phase 2.3 | 本地 Host 探测，可公开 |
| `GET /local/v1/tools` | Phase 2.3 | 返回本地可用工具和权限状态，需要 pairing token |
| `POST /local/v1/runs` | Phase 2.3 | 创建本地 run shell，需要 pairing token |
| `GET /local/v1/runs/{id}/stream` | Phase 2.3 | SSE 事件流，需要 pairing token |
| `POST /local/v1/runs/{id}/cancel` | Phase 2.3 | 取消本地 run，需要 pairing token |

---

## 五、数据流

### 5.1 登录与会话

```
用户登录 → 后端返回 access token → 前端内存保存
Refresh token 写入 HTTPOnly Cookie
页面刷新 → 调用 /auth/refresh → 恢复 access token
```

### 5.2 聊天流

```
用户发送消息
  → 前端写入本地 user message 和空 assistant message
  → POST /api/v1/chat/completions，携带 client_conversation_id / client_message_id
  → 后端创建额度预留
  → SSE 增量返回 assistant delta
  → 前端持续写入本地 assistant message
  → 流结束后前端写入 request_id、tokens、credits、status，并刷新余额
```

### 5.3 支付流

```
用户点击升级 / 充值
  → 前端请求 checkout
  → 后端创建 payment_order
  → 前端跳转 Stripe Checkout
  → Stripe Webhook 更新钱包
  → 前端 success 页轮询 /billing/subscription 或 /billing/balance
```

### 5.4 文件上传流

```
选择文件
  → 请求 /files/upload-url，默认 purpose=temporary_input
  → 直传 S3
  → 调用 /files/confirm
  → 后端返回 expires_at
  → 文件进入 processing / ready / failed 状态
  → 前端在对话或本地文件索引中展示状态和临时留存提示
```

### 5.5 分享流

```
用户点击分享
  → 前端从本地数据库读取选定消息
  → 用户确认分享范围、脱敏内容和过期时间
  → POST /api/v1/shared-conversations 上传 snapshot
  → 后端返回 share_url / token
  → 前端保存分享记录，可撤销
```

### 5.6 Agentic Chat / Agent Run 流（Phase 2+）

```
用户输入目标或上传附件
  → 创建 agent run 或本地消息任务
  → 前端订阅 run events / SSE
  → 系统选择 skill 和工具
  → 云端工具由后端执行，本地工具由 Local Harness 执行
  → 高风险本地工具先请求权限
  → 工具结果回传
  → run 完成 / 失败 / 取消
  → 后端结算额度
```

---

## 六、状态与错误处理

### 6.1 全局状态

- `auth`：当前用户、登录状态、access token 生命周期
- `billing`：钱包、订阅、额度、支付轮询状态
- `localData`：IndexedDB / SQLite 连接状态、迁移版本、导入导出状态
- `chat`：当前本地会话、SSE 状态、消息草稿
- `workspace`：个人上下文；团队上下文 Phase 5 启用
- `agent`：Phase 2+ run、events、tool calls、permission requests

### 6.2 错误展示

| 错误 | 前端行为 |
|------|----------|
| 未登录 / token 过期 | 清空会话并跳转登录 |
| 额度不足 | 展示升级或充值入口 |
| SSE 中断 | 保留已收到的本地内容，提示重试 |
| 文件上传失败 | 展示重试和错误原因 |
| 本地数据库不可用 | 进入只读错误页，提示导出备份或清空本地缓存 |
| 工具权限被拒绝 | 标记 tool call 为 rejected，不自动重试 |
| 支付未到账 | success 页轮询，并提示稍后刷新 |

---

## 七、安全与隐私

- 前端日志不得记录 access token、Refresh Cookie、支付信息、完整文件内容。
- 本地数据库不得上传到后端，除非用户主动分享、反馈问题或开启未来 Cloud Sync。
- Electron renderer 禁用 Node.js 直接能力，只通过 preload 暴露最小 API。
- 本地工具默认关闭，用户在设置中显式开启。
- 本地文件访问必须限定用户选择的文件或目录。
- Browser / Computer 操控必须显示当前动作和可取消状态。
- Web 端永远不执行本地工具。
- 所有本地工具结果回传后端时只传必要摘要和文件引用。

---

## 八、验收标准

### Phase 1

- 用户可以注册、登录、发起基础聊天并看到流式回复。
- 用户刷新页面或重启桌面端后，可以从本地恢复聊天历史。
- 用户可以看到本月额度、额外额度和订阅状态。
- 用户可以进入 Stripe Checkout 完成订阅，回到前端后看到状态刷新。
- 用户可以导出 / 导入本地聊天数据。
- Web 与 Electron 使用同一套核心 React UI。

### Phase 2

- 用户无需切换模式即可完成普通聊天。
- 用户可以在同一个 composer 上传 PDF / DOCX / XLSX 并提问。
- 复杂任务可以展示 run timeline、skill 选择、工具调用、来源、最终答案和取消状态。
- Local Harness 离线时，Web 使用云端受限能力并给出明确状态。
- Electron 能探测 Local Harness health，并在 UI 中显示本地/云端受限状态。
- Electron paired mode 可以从统一 composer 创建本地 run，并展示权限、artifact 与 verification timeline。

### Phase 2.4+

- Electron 可以连接 Local Agent Harness。
- 用户可以授权读取本地文件或项目。
- 用户选择或填写的本地工作区必须先通过 Local Host 授权；未授权路径不能创建本地 run。
- 用户可以诊断或撤销已授权工作区；撤销当前工作区后 composer 的本地项目引用必须同步清除。
- 用户可以在本地 run timeline 中批准或拒绝 `shell.run` 等高风险工具请求。
- 大工具输出以 artifact 引用展示，用户按需打开预览。
- 本地 MCP、受控 shell、浏览器/IDE 工具只在权限允许时出现。
- 私有本地内容不默认同步到云端。

### Phase 4

- Office / 图片生成任务有队列状态和结果文件入口。
- 多工具编排有 artifact、来源、上下文压缩和恢复能力。
- 工具失败、取消、超时、超预算都有清晰 UI 状态。

### Phase 5

- 团队后台、成员用量、团队钱包和 Agent run 摘要可管理。
- 团队请求明确使用 `organization_id`。
- Chrome Use / Computer Use 默认关闭，并要求明确授权。

---

*文档版本: v1.2*
*最后更新: 2026-05-10*
