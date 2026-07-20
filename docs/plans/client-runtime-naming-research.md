# SheJane Client / Runtime 命名与开发入口研究

> 研究日期：2026-07-19  
> 范围：目录、包名、命令、环境变量、日志、协议、文档与故障定位。  
> 目标：继续使用一个 Git monorepo，但让维护者第一眼只看到两个产品模块：**Client** 与 **Runtime**。

## Runtime 阶段记录

- `primary_stage`：P1，Client 启动并建立 Runtime 会话。
- 直接上游：Electron Main 的 Client 进程启动与 Runtime 进程编排。
- 直接下游：P2，Client 通过 Runtime SDK 提交幂等命令。
- 权威状态所有者：Client 的 Runtime connection controller 负责连接投影；Runtime session 负责握手、能力与认证真相。
- 被替换的旧路径：Desktop / daemon / local-host 三套别名与对应目录、命令、环境变量和协议路径。

## 结论

SheJane 应直接采用两个一级目录：

```text
client/
runtime/
```

不再保留 `apps/`、`services/`、`packages/` 这三层通用分类。它们适合拥有多个应用、多个服务、多个公共包的大型 monorepo；SheJane 当前只有两个主要运行主体，分类层只会让人先理解仓库框架，再理解产品。

模块定义固定为：

- **Client**：人类操作的界面与 Runtime 状态投影；当前交付形态是 Electron Desktop。
- **Runtime**：独立运行的 Agent 执行核心，拥有 HTTP/SSE 协议、持久状态、Tool、Plugin 与 Runtime SDK。

`Desktop` 只描述 Client 当前的交付形态，不再作为第三套模块名。`Runtime SDK` 是 Runtime 的公开子包，不是第三个产品模块。

## 建议目录

```text
client/
├── electron/
├── e2e/
├── src/
└── package.json

runtime/
├── src/
│   └── shejane_runtime/
├── tests/
├── sdk/
│   ├── src/
│   ├── openapi.json
│   └── package.json
├── plugins/
│   ├── schemas/
│   ├── fixtures/
│   ├── runtime-assets/
│   └── <plugin packages>/
├── pyproject.toml
└── shejane-runtime.spec

docs/
scripts/
```

具体映射：

| 当前路径 | 目标路径 | 理由 |
|---|---|---|
| `apps/desktop/` | `client/` | Client 是稳定模块名；Electron 只是当前载体 |
| `services/runtime/` | `runtime/` | Runtime 本身就是独立运行主体，不需要 `services/` 分类层 |
| `services/runtime/local_host/` | `runtime/src/shejane_runtime/` | Python import 与产品名一致；采用标准 `src` layout |
| `packages/runtime-sdk/` | `runtime/sdk/` | SDK 由 Runtime 协议产生并随协议修改，不是独立产品 |
| `plugins/` | `runtime/plugins/` | Plugin 的发现、权限、执行和生命周期均由 Runtime 拥有 |
| `schemas/` | `runtime/plugins/schemas/` | 当前 schema 都属于 Plugin 或 Managed Worker 契约 |
| `apps/desktop/src/shared/local-host/` | `client/src/runtime/` | 这是 Client 的 Runtime adapter，不是一个叫 Local Host 的模块 |

把 TypeScript SDK 放到 `runtime/sdk/` 不等于取消它的独立 package：保留自己的 `package.json`、构建、测试和发布即可。目录表达所有权，包清单表达工具链与发行边界。

## 为什么选择 Client，而不是 Desktop

官方项目通常用一眼能辨认的运行角色命名入口。VS Code 区分 Desktop、Web 与 Code Server；Ollama 区分 App、Server、API；它们的名字都服务于“这段代码在哪里运行”。但 SheJane 当前要解决的问题是开发者反复判断“界面问题还是执行核心问题”，而用户已形成 `Client ↔ Runtime` 的心智模型。

因此这里选择：

```text
稳定模块名：Client
当前产品形态：Desktop Client
安装后显示名：SheJane / 石间
```

若未来真的出现第二种 Client，再把 `client/` 扩为 `client/desktop/` 与 `client/<other>/`。现在提前保留 `apps/desktop/` 是为尚不存在的产品付认知成本。

## 统一词表

| 语境 | 唯一名称 | 不再使用 |
|---|---|---|
| UI 模块 | Client | Desktop 作为模块名、App、前端 |
| Agent 执行模块 | Runtime | Daemon、Local Host、Server 作为模块名 |
| TS 协议包 | Runtime SDK | interface layer、API module、第三模块 |
| Client 内协议适配 | Runtime client / Runtime connection | local-host client |
| Runtime 子进程 | Runtime process | daemon process |
| HTTP 实现细节 | HTTP server | Runtime Server 作为产品名 |
| 本机安全边界 | loopback-only / local workspace | Local Host 作为专有名词 |

`server`、`process`、`local` 仍可作为普通技术描述，但不能再成为模块别名。例如“Runtime 的 HTTP server 只监听 loopback”是准确的；“启动 Local Host daemon”不是。

### 代码与协议名称

建议一并替换，不保留兼容别名：

| 当前 | 目标 |
|---|---|
| Python package `local_host` | `shejane_runtime` |
| `SHEJANE_LOCAL_HOST_URL` | `SHEJANE_RUNTIME_URL` |
| `SHEJANE_LOCAL_HOST_TOKEN` | `SHEJANE_RUNTIME_TOKEN` |
| `VITE_TEST_LOCAL_HOST_URL` | `VITE_TEST_RUNTIME_URL` |
| `LocalHostConfig` | `RuntimeConnection` |
| `daemonProcess` / `daemonURL` | `runtimeProcess` / `runtimeURL` |
| `.tmp/dev/local-host.log` | `.tmp/dev/runtime.log` |
| `/local/v1/*` | `/v1/*` |

`/runtime/v1/*` 会在已经连接到 Runtime 的 base URL 上重复服务名，`/v1/*` 更短也更常见。因为本次明确不保留旧名称，应在同一次协议变更中更新 Runtime、OpenAPI、SDK、Client 与 contract tests，不增加双路由。

## 命令面

根 Makefile 是人类入口。命令统一采用 `动作-模块`，聚合命令不带模块：

```text
make dev                  # Client + Runtime
make dev-client           # 只启动 Client，连接显式指定的 Runtime
make dev-runtime          # 只启动 Runtime
make restart-runtime
make doctor

make test                 # Client unit + Runtime unit + Runtime SDK unit
make test-client
make test-runtime
make test-runtime-sdk
make test-contract        # 真实 Runtime HTTP/SSE + SDK，不启动 Electron
make test-e2e             # Client + Runtime 用户路径
make test-packaged        # 打包后 Client/Runtime 生命周期

make build
make build-client
make build-runtime
make build-runtime-sdk
make schemas

make logs
make logs-client
make logs-runtime
```

应删除而不是保留别名的旧目标包括 `dev-electron`、`restart-daemon`、`client-test`、`local-host-test`、`runtime-sdk-test`、`client-build`、`local-host-build`、`build-daemon`、`logs-local-host`、`logs-dev`。删除旧入口能让 README、自动补全和错误搜索只出现一种说法。

模块目录仍应提供工具链原生命令，便于精准迭代：

```bash
cd client && pnpm test --run
cd runtime && uv run python -m pytest
pnpm --dir runtime/sdk test
```

根命令负责“我想检查哪个故障域”，目录原生命令负责“我已经知道要改哪一个测试文件”。

## 故障定位矩阵

| 最小检查 | 通过/失败代表什么 | 下一步 |
|---|---|---|
| `make test-runtime` | Agent loop、状态、Tool、Plugin 或 Runtime HTTP 实现 | 失败就留在 Runtime；通过再测 SDK |
| `make test-runtime-sdk` | OpenAPI 类型、HTTP client、SSE parser | 失败是 Runtime 协议包；通过再测 contract |
| `make test-client` | React 状态、投影、交互或 Electron 单元行为 | 失败就留在 Client |
| `make test-contract` | 真实 Runtime 与 SDK 的 HTTP/SSE 契约 | 两边单测通过而这里失败，就是协议边界 |
| `make test-e2e` | Client 投影、进程编排与完整用户路径 | contract 通过而这里失败，优先查 Client/Electron 编排 |
| `make test-packaged` | 冻结 Runtime、资源路径、签名包和子进程生命周期 | 源码 E2E 通过而这里失败，就是 packaging |

推荐排查顺序：

```text
Runtime → Runtime SDK → Client → Contract → E2E → Packaged
```

这不是要求每次全跑。开发者从症状最可能所属的最小一层开始，只在该层通过后向右扩大。

## 一手范式与取舍

### VS Code：同仓库保留多个可独立运行入口

VS Code 官方贡献文档分别提供 `./scripts/code.sh`、`./scripts/code-web.sh`、`./scripts/code-server.sh --launch`，并用 `./scripts/test.sh` 提供统一测试入口。官方也明确说明它是多进程架构。[How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute)

可复用：一个 monorepo 同时拥有独立运行入口和聚合测试入口；命令使用具体运行角色。  
不照搬：VS Code 的 `base/platform/editor/workbench/code/server` 分层来自远大于 SheJane 的规模，不能成为保留 `apps/services/packages` 空泛分类的理由。[Source Code Organization](https://github.com/microsoft/vscode/wiki/source-code-organization)

### Ollama：核心不依赖 GUI 也能启动和测试

Ollama 官方开发文档从仓库根直接使用 `go run . serve` 启动核心、使用 `go test ./...` 测试；其仓库同时保留 `app/`、`server/`、`api/` 等明确角色。[Development](https://github.com/ollama/ollama/blob/main/docs/development.md)、[official repository](https://github.com/ollama/ollama)

可复用：Runtime 必须有无需 Client 的启动和测试入口；API client 与 server 同库。  
不照搬：Ollama 是单 Go module，根级 `api/` 没有跨语言 workspace 成本；SheJane 的 SDK 仍需保留独立 TypeScript package。

Ollama 只把拥有真实外部消费者和独立发行节奏的 [Python SDK](https://github.com/ollama/ollama-python) 与 [JavaScript SDK](https://github.com/ollama/ollama-js) 拆成独立仓库。这支持 SheJane 现阶段把 Runtime SDK 留在同一 monorepo 并明确归 Runtime 所有。

### LangGraph：SDK 是库边界，不是第三个产品模块

LangGraph 官方 `AGENTS.md` 将 `sdk-js` 与 `sdk-py` 定义为访问 LangGraph Server API 的库，并把它们与 core、CLI、checkpoint 等库放在同一 monorepo；每个库运行自己的 `make format`、`make lint`、`make test`，根文档同时给出依赖图。[LangGraph AGENTS.md](https://github.com/langchain-ai/langgraph/blob/main/AGENTS.md)

可复用：Runtime SDK 应有独立测试和发行边界，但在架构图和故障分类中仍属于 Runtime。  
不照搬：LangGraph 有许多同级库，所以使用 `libs/` 合理；SheJane 只有一个 Runtime SDK，不需要 `packages/` 作为永久中间层。

### Tauri：一个人类命令可以编排跨语言开发栈

Tauri 官方架构文档把 `pnpm tauri dev` 定义为同时启动前端 dev server、编译 Rust 并打开应用窗口；另用 `pnpm tauri info` 做诊断、`pnpm tauri build` 做发行构建。[Tauri Architecture](https://github.com/tauri-apps/tauri/blob/dev/ARCHITECTURE.md)

可复用：`make dev` 应是完整栈默认入口，`make doctor` 应输出 Client 与 Runtime 两边的状态。  
不照搬：Tauri 的 `crates/` 与 `packages/` 是大量 Rust/JS 公共库的生态布局；SheJane 的目标是两个产品模块，不应复制其目录数量。

## 迁移顺序

这应作为一次原子命名迁移完成，避免半套词汇比旧结构更难理解：

1. 移动 `client/`、`runtime/`、Runtime SDK、Plugin 与 schema，并更新 workspace/build 配置。
2. 把 Python import package 改为 `shejane_runtime`，更新 PyInstaller、CLI 与测试 imports。
3. 更新 Runtime SDK 生成路径、npm workspace、包 repository path 与 release workflow。
4. 更新 Client Runtime adapter 路径、TypeScript identifiers、Electron process identifiers、环境变量与 API base path。
5. 更新 scripts、Makefile、CI、packaging、日志名与临时目录名。
6. 更新 README、README.zh-CN、AGENTS、CLAUDE、CONTRIBUTING、operations、run-loop 与相关开发文档。
7. 运行全仓旧词搜索；除本研究的迁移说明和真实第三方术语外，不允许再出现旧模块名。
8. 按 `test-runtime → test-runtime-sdk → test-client → test-contract → test-e2e → test-packaged` 验证，再运行完整 `make test`、`make build` 与 `git diff --check`。

完成标准不是“新命令能用”，而是新贡献者只看根目录、`make help`、README 和 AGENTS 就能回答：代码属于 Client 还是 Runtime，应该先运行哪个检查，跨边界失败应该去哪里查。
