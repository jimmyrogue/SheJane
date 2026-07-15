# SheJane 运维手册

SheJane 由 Desktop、Runtime 和公共 Runtime SDK 组成，默认不读取根目录环境变量。

## 本地开发

首次安装：

```bash
make setup-hooks
corepack enable
pnpm install
cd services/runtime && uv sync
```

启动桌面 Harness：

```bash
make dev-electron
```

该命令启动源码 Runtime、Vite 和 Electron。

常用排障：

```bash
make doctor
make restart-daemon
make logs-local-host
```

## Runtime 配置

Runtime 默认不要求用户环境变量。

- Desktop Main 启动托管 Runtime 时，通过命令行传入本机地址、随机端口和配对 Token。
- Desktop 不提供 Runtime 连接设置。开发者接入外部 loopback Runtime 时，地址与 Token 由 Electron Main 配置和保存，不回传明文 Token 给 Renderer。
- 模型供应商、模型资料和高级默认设置通过 Runtime API 保存。
- BYOK 密钥写入操作系统凭据库，不写入 SQLite、Run 快照或环境变量。
- `--data-dir` 可以修改 Runtime 数据目录。

开发和测试可以使用 `SHEJANE_FAKE_LLM`、tracing 变量以及 Skills/MCP 路径覆盖，但这些不是用户安装配置，也不提供公开 `.env.example`。

## 添加 BYOK 供应商

Desktop 的模型供应商设置会调用 Runtime 的 `/local/v1/model-providers` 接口。当前生产适配器支持 OpenAI 兼容接口和 Anthropic 原生接口。

Desktop 提供 OpenAI、OpenRouter、DeepSeek、Anthropic、自定义 OpenAI 和自定义 Anthropic 入口。填写 API Key 后，Runtime 会从供应商的模型目录读取模型；Desktop 会显示可搜索的列表，并允许为同一个供应商勾选多个模型。手动填写时使用“+”增加模型输入框。上下文上限收在高级设置中，模型默认启用流式输出和工具调用。

供应商的模型目录通常不包含可靠的图片能力信息。每个模型因此默认标记为“仅文本”；只有供应商文档明确说明模型支持图片输入时，才在模型设置中开启“支持图片”。模型选择器会显示该能力。文本模型读取图片时，Runtime 会返回明确的能力限制，不把图片内容交给模型猜测。

任务使用明确的 `local:<供应商编号>:<模型编号>`。Runtime 不自动选择模型或静默切换供应商。

## 构建 Runtime

Runtime 暂不单独发布二进制文件。请在目标操作系统和 CPU 架构上从源码构建：

```bash
cd services/runtime
uv sync --frozen
uv run pyinstaller shejane-runtime.spec --noconfirm --clean
```

构建结果位于 `services/runtime/dist/shejane-runtime/`。其中包含平台相关的原生依赖，不能用于其他操作系统或 CPU 架构。

## 发布

公开发布使用两个标签：

```text
desktop-vX.Y.Z
runtime-sdk-vX.Y.Z
```

Desktop CI 在三个原生 runner 上分别构建 Runtime 和安装包：

```text
desktop-macos-arm64
desktop-macos-x64
desktop-windows-x64
```

手动运行 Desktop 发布工作流只生成 GitHub Actions 产物。推送 `desktop-vX.Y.Z` 标签才会创建 GitHub Release。

正式 Desktop 安装包必须：

- 从同一次提交构建并内置对应平台和架构的 Runtime；
- 只停止 Electron Main 自己启动的 Runtime，不停止外部 Runtime。

## 验证

```bash
make lint
make test
make build
make test-e2e
git diff --check
```

`make test-e2e` 会在隔离目录中启动真实 Runtime，并验证公开 HTTP、命令、SSE、Agent、工具和持久状态。详细范围见 [Runtime 端到端测试](./runtime-e2e-testing.md)。`make test-contract` 仅作为旧命令别名保留。

发布前还应确认：

- 清空用户环境变量后，Desktop 和 Runtime 可以启动；
- BYOK 模型能够完成“模型 → 工具 → 模型”；
- 仓库没有根 `.env.example`、模块 `package-lock.json` 或旧目录引用；
- Desktop 源码只连接 Runtime；
- Desktop 安装包包含由同一次提交构建的 Runtime。

## 安全边界

- Runtime 只监听 loopback；远程连接必须经过未来的独立网关，不能直接暴露 Runtime。
- 不要打印或提交任何 `.env`、Token 或 BYOK 密钥。
- 不要增加产品私有的会话、模型或工具网关。
- 外部能力通过标准模型供应商或 MCP 接入。
