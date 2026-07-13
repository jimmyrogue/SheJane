# SheJane 产品说明

**更新日期：** 2026-07-13  
**状态：** 当前产品边界

## 产品定位

SheJane 是一个可独立运行的桌面 Agent Harness：

- `services/runtime/` 是核心运行时，负责模型调用、工具、权限、状态、检查点和产物。
- `apps/desktop/` 是官方 Electron 客户端，只通过公开 Runtime 协议工作。
- 用户使用自己的模型密钥、本地模型或兼容 OpenAI 接口的中转服务。
- Desktop 和 Runtime 不依赖 SheJane Cloud；本地 Runtime 失败时明确报错，不回退云端任务。

## 模块边界

| 模块 | 职责 | 是否为核心依赖 |
|---|---|---:|
| `services/runtime/` | Python Harness Runtime | 是 |
| `apps/desktop/` | Electron 桌面客户端 | 是 |
| `packages/runtime-client/` | Runtime TypeScript SDK | 是 |

## 核心原则

1. Runtime 可以脱离 Desktop 独立启动。
2. Desktop 只连接 Runtime，不直接调用 Cloud Agent、模型目录或计费接口。
3. Runtime 只监听本机回环地址；未来远程连接由独立网关处理。
4. 模型必须是 Runtime 中已配置的具体 `local:<provider>:<model>`，不自动切换模型。
5. 模型密钥保存在操作系统凭据库，不进入环境变量、任务记录或客户端存储。
6. 任务状态、事件、命令、检查点和工具回执以 Runtime 持久数据为准。
7. 飞书等业务连接器不进入 Runtime 核心；需要时通过标准工具或 MCP 接入。

## 配置

- Desktop、Runtime 和 Runtime SDK 默认不需要环境变量。
- Runtime 的供应商和运行设置通过本地接口保存。
- 仓库根目录没有共享 `.env.example`。

## 当前不做

- Web 聊天客户端。
- Desktop 与 Cloud 的专用运行链路。
- 移动端 Harness。
- Runtime 直接暴露公网。
- 多模型自动回退。
- 预先创建没有实现的未来模块。

## 详细资料

- 目标阶段：[`docs/harness-runtime-stages.md`](docs/harness-runtime-stages.md)
- 当前运行链路：[`docs/run-loop.md`](docs/run-loop.md)
- 待优化记录：[`docs/harness-stage-improvement-notes.md`](docs/harness-stage-improvement-notes.md)
- 模块结构：[`docs/monorepo-architecture.md`](docs/monorepo-architecture.md)
- 开发与部署：[`docs/operations.md`](docs/operations.md)
- 当前路线图：[`docs/roadmap.md`](docs/roadmap.md)
