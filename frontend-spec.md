# 简单（Jiandan）前端技术方案

**版本：** v1.0
**更新：** 2026-05-10
**适用阶段：** Phase 1-5 分阶段落地

> 本文档补充 `project-plan.md` 与 `backend-spec.md` 中缺失的前端客户端设计。前端目标是先完成可收费聊天 MVP，再逐步演进为场景化工作台和 Hybrid 本地优先 Agent Client。

---

## 一、前端定位

### 1.1 产品目标

前端不是模型管理器，也不是纯聊天壳，而是面向非技术用户的工作台：

- Phase 1：注册登录、基础聊天、快速/深度模式、额度展示、订阅入口
- Phase 2：场景卡片、模板、文件上传、对话搜索/导出/分享、额外额度包
- Phase 3：个人文件库、个人知识库、个人 Prompt 收藏、用量历史
- Phase 4：个人 API + 文件工具 Agent、Office/图片生成任务状态
- Phase 5：团队管理后台、Chrome Use / Computer Use / MCP 等长期能力

### 1.2 客户端形态

| 客户端 | 能力边界 | 说明 |
|--------|----------|------|
| Web | 云端 API、聊天、文件上传、个人工作台、支付 | 不执行本地工具，不操控浏览器或电脑 |
| Electron | Web 全部能力 + 本地桌面能力预留 | Phase 4 后可作为 Local Agent Host |
| PWA / Capacitor | Phase 5 之后评估 | 只复用核心业务能力，不优先承载本地工具 |

### 1.3 核心原则

- **共享优先**：Web 与 Electron 共享 80%+ React 组件、状态和 API client。
- **桌面增强**：Electron 只承载 Web 无法安全完成的本地能力。
- **权限显式**：本地文件、浏览器、电脑控制类工具必须由用户确认。
- **账务一致**：所有模型与工具消耗都走后端钱包预留/结算，前端只展示状态。
- **简单默认**：MVP 不出现模型、token、API key、供应商配置等概念。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                 React Shared App                         │
│  Routes / Components / Stores / API Client / SSE Client  │
└───────────────┬───────────────────────────┬─────────────┘
                │                           │
                ▼                           ▼
┌──────────────────────────┐      ┌────────────────────────┐
│ Web Runtime              │      │ Electron Runtime       │
│ Browser APIs only        │      │ Main + Preload + IPC   │
│ No local tools           │      │ Local Agent Host later │
└───────────────┬──────────┘      └─────────────┬──────────┘
                │ HTTPS / SSE                   │ HTTPS / SSE + IPC
                └───────────────┬───────────────┘
                                ▼
┌─────────────────────────────────────────────────────────┐
│                 Go API Gateway                           │
│ Auth / Chat SSE / Billing / File / Personal Agent later  │
└─────────────────────────────────────────────────────────┘
```

### 2.1 推荐项目结构

```text
jiandanly-client/
├── src/
│   ├── app/                 # 路由、布局、全局 provider
│   ├── features/
│   │   ├── auth/            # 登录、注册、刷新会话
│   │   ├── chat/            # 对话、SSE、消息列表
│   │   ├── billing/         # 额度、订阅、充值入口
│   │   ├── conversations/   # 列表、搜索、分享、导出
│   │   ├── templates/       # 场景模板
│   │   ├── files/           # 上传、确认、文件状态
│   │   ├── personal/        # 个人文件库、个人知识库、用量历史
│   │   ├── team/            # Phase 5 团队后台
│   │   ├── settings/        # 账号、安全、偏好
│   │   └── agent/           # Phase 4+ Agent UI 与任务事件
│   ├── shared/
│   │   ├── api/             # REST client、SSE client、错误处理
│   │   ├── ui/              # 基础组件
│   │   ├── store/           # 全局状态
│   │   └── utils/
│   └── main.tsx
├── electron/
│   ├── main.ts              # 窗口、菜单、更新、本地能力调度
│   ├── preload.ts           # 安全 IPC 暴露
│   └── agent-host/          # Phase 4+ 本地工具注册与执行
└── package.json
```

---

## 三、核心模块

### 3.1 Auth

- Access Token 存前端内存，Refresh Token 使用 HTTPOnly Cookie。
- 启动时调用 `/api/v1/auth/refresh` 恢复会话。
- 登录态失效时清空本地业务状态并跳转登录页。
- 前端不保存供应商 API key，不提供 BYOK 设置入口。

### 3.2 Chat / SSE

- Phase 1 只支持基础文本聊天和 `fast` / `deep` 模式。
- SSE client 负责解析 OpenAI-compatible stream，并把增量内容写入当前 assistant message。
- 客户端断线后重新拉取对话详情；真正断线续传等 Phase 4 的 generation events。
- 发送前展示额度不足、未登录等明确错误；团队钱包错误只在 Phase 5 出现。

### 3.3 Billing

- 展示本月额度、额外额度、预计可用次数、订阅状态。
- 包月订阅通过后端 Checkout URL 跳转 Stripe。
- 额外额度包只作为月额度耗尽后的补充购买入口。
- 支付完成后回到前端 success 页面并轮询后端账单状态，不以前端 URL 参数直接加额度。

### 3.4 Conversation

- Phase 1：对话列表、详情、重命名、归档/删除。
- Phase 2：搜索、分享、导出。
- 分享默认使用快照，前端提醒用户链接可被访问，并支持撤销。

### 3.5 Template / Scene

- Phase 2 首页从空白聊天升级为场景卡片。
- 场景只表达用户任务：帮我写、帮我读、帮我算、帮我翻译、自由对话。
- 前端负责收集结构化输入，后端负责注入 system prompt 和计费。

### 3.6 File Upload

- 文件上传走 S3 预签名 URL：
  1. 前端向后端申请 upload URL
  2. 前端直传 S3
  3. 前端调用 confirm 接口
  4. 后端记录文件元数据并进入处理流程
- 前端限制文件类型和大小，但以后端校验为准。
- Web 与 Electron 上传逻辑共享；Electron 后续可增强本地文件选择体验。

### 3.7 Personal Workspace

- Phase 3 启用。
- 支持个人文件库、个人知识库、个人 Prompt 收藏、用量历史。
- 所有个人能力默认绑定用户钱包，不需要选择团队上下文。
- 数据导出、删除和账号安全入口也放在个人设置中。

### 3.8 Team Admin

- Phase 5 启用。
- 支持组织信息、成员列表、角色、成员月上限、团队账单、团队模板。
- 使用团队钱包时，请求必须显式带 `organization_id`，前端不能静默猜测。

### 3.9 Settings

- 账号资料、密码、安全会话、通知偏好。
- 不出现 BYOK、供应商 key、模型 provider 配置。
- Electron 可额外显示本地权限状态，但不在 Phase 1 实现。

---

## 四、Agent 前端路线

### 4.1 结论

Agent 能力采用 **Hybrid 本地优先**：

- 云端：模型路由、个人账本、云端工具、任务事件持久化；团队策略 Phase 5 启用
- Electron：本地工具执行、浏览器/电脑权限确认、本地执行日志
- Web：只展示和调用云端工具，不执行本地工具

### 4.2 Phase 4：API + 文件工具 Agent

第一版 Agent 只做低风险工具：

- 云端 RAG 检索
- Office / 图片生成任务状态
- 已授权文件上传与分析
- 后端 API 工具调用

前端需要提供：

- Agent run 页面：任务目标、事件流、工具状态、取消按钮
- Tool call 卡片：工具名、输入摘要、执行状态、结果文件
- 额度提示：工具执行前展示预计消耗，实际结算以后端为准

### 4.3 Phase 5：Chrome Use / Computer Use

高风险本地自动化后置：

- Chrome Use：读取网页、点击、表单填写、下载文件
- Computer Use：操控桌面 app、截图、点击、键盘输入
- MCP：连接外部工具和企业系统

这些能力只允许在 Electron 中开启，且必须有：

- 工具 allowlist
- 每次高风险动作前的用户确认
- 可见的执行轨迹和取消按钮
- 权限日志和审计记录
- 敏感输入遮蔽

### 4.4 Electron IPC 安全边界

```text
Renderer 不能直接访问 Node.js / 文件系统 / shell
Renderer → preload 暴露安全 API
preload → main 通过白名单 IPC 调用
main → local tool executor 执行受控工具
```

预留 IPC 命名：

| IPC | 阶段 | 说明 |
|-----|------|------|
| `agent.tools.list` | Phase 4 | 返回本地可用工具和权限状态 |
| `agent.tools.execute` | Phase 4 | 执行受控本地工具 |
| `agent.permissions.request` | Phase 4 | 请求用户授权 |
| `agent.run.cancel` | Phase 4 | 取消本地执行中的任务 |

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
  → 前端创建 optimistic user message
  → POST /api/v1/chat/completions
  → 后端创建额度预留
  → SSE 增量返回 assistant message
  → 流结束后前端刷新余额和对话元数据
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
  → 请求 /files/upload-url
  → 直传 S3
  → 调用 /files/confirm
  → 文件进入 processing / ready / failed 状态
  → 前端在对话或文件列表展示状态
```

### 5.5 Agent Run 流（Phase 4+）

```
用户输入目标
  → 创建 agent run
  → 前端订阅 run events
  → 模型提出 tool call
  → 云端工具由后端执行，本地工具由 Electron 执行
  → 工具结果回传
  → run 完成 / 失败 / 取消
  → 后端结算额度
```

---

## 六、状态与错误处理

### 6.1 全局状态

- `auth`：当前用户、登录状态、access token 生命周期
- `billing`：钱包、订阅、额度、支付轮询状态
- `chat`：当前会话、SSE 状态、消息草稿
- `workspace`：个人上下文；团队上下文 Phase 5 启用
- `agent`：Phase 4+ run、events、tool calls

### 6.2 错误展示

| 错误 | 前端行为 |
|------|----------|
| 未登录 / token 过期 | 清空会话并跳转登录 |
| 额度不足 | 展示升级或充值入口 |
| SSE 中断 | 保留已收到内容，提示刷新对话状态 |
| 文件上传失败 | 展示重试和错误原因 |
| 工具权限被拒绝 | 标记 tool call 为 rejected，不自动重试 |
| 支付未到账 | success 页轮询，并提示稍后刷新 |

---

## 七、安全与隐私

- 前端日志不得记录 access token、Refresh Cookie、支付信息、完整文件内容。
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
- 用户可以看到本月额度、额外额度和订阅状态。
- 用户可以进入 Stripe Checkout 完成订阅，回到前端后看到状态刷新。
- Web 与 Electron 使用同一套核心 React UI。

### Phase 2

- 用户打开首页看到场景卡片，而不是只有空白对话框。
- 用户可以上传文件并看到处理状态。
- 用户可以搜索、分享、导出对话。
- 用户可以购买额外额度包。

### Phase 3

- 用户可以查看个人文件库、文件状态和历史引用。
- 用户可以建立个人知识库并在回答中看到引用来源。
- 用户可以收藏个人 Prompt，并查看按日 / 按场景的个人用量。

### Phase 4

- Agent run 有清晰事件流、工具状态和取消入口。
- 本地工具只在 Electron 中出现。
- Office / 图片生成任务有队列状态和结果文件入口。

### Phase 5

- 团队后台、成员用量、团队钱包和团队模板可管理。
- 团队请求明确使用 `organization_id`。
- Chrome Use / Computer Use 默认关闭，并要求明确授权。

---

*文档版本: v1.0*
*最后更新: 2026-05-10*
