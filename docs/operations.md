# SheJane 运维手册

SheJane 由 Desktop、Runtime 和公共 Runtime SDK 组成。默认不读取根目录环境变量，也不依赖任何 SheJane 云服务。

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
- 外部 Runtime 的地址与 Token 保存在 Electron Main 的配置和凭据存储中，不回传明文 Token 给 Renderer。
- 模型供应商、模型资料和高级默认设置通过 Runtime API 保存。
- BYOK 密钥写入操作系统凭据库，不写入 SQLite、Run 快照或环境变量。
- `--data-dir` 可以修改 Runtime 数据目录。

开发和测试可以使用 `SHEJANE_FAKE_LLM`、tracing 变量以及 Skills/MCP 路径覆盖，但这些不是用户安装配置，也不提供公开 `.env.example`。

## 添加 BYOK 供应商

Desktop 的模型供应商设置会调用 Runtime 的 `/local/v1/model-providers` 接口。当前生产适配器支持 OpenAI 兼容接口。

每个模型必须声明：

- 模型编号；
- 是否支持流式输出；
- 是否支持工具调用；
- 输入和输出上下文上限。

任务使用明确的 `local:<供应商编号>:<模型编号>`。Runtime 不执行 Auto 解析、Cloud 回退或 fast/deep 分类。

## 发布

模块使用独立标签：

```text
runtime-vX.Y.Z
desktop-vX.Y.Z
runtime-client-vX.Y.Z
```

Desktop 的 `apps/desktop/runtime-version.json` 锁定 Runtime Release。正式打包会下载并校验该版本；源码开发直接运行当前 Runtime。

Runtime Release 提供 macOS arm64/x64、Windows x64、Linux x64 压缩包和 SHA-256 文件。

## 验证

```bash
make lint
make test
make build
make test-contract
git diff --check
```

发布前还应确认：

- 清空用户环境变量后，Desktop 和 Runtime 可以启动；
- 不配置任何 SheJane 云服务时，BYOK 模型仍能完成“模型 → 工具 → 模型”；
- 仓库没有根 `.env.example`、模块 `package-lock.json` 或旧目录引用；
- Desktop 源码只连接 Runtime；
- Desktop 安装包只包含锁定版本的 Runtime。

## 安全边界

- Runtime 只监听 loopback；远程连接必须经过未来的独立网关，不能直接暴露 Runtime。
- 不要打印或提交任何 `.env`、Token 或 BYOK 密钥。
- 不要在 Runtime 恢复 `SHEJANE_CLOUD_*`、`/local/v1/session` 或专用 Go Gateway。
- 远程能力通过标准模型供应商或 MCP 接入。
