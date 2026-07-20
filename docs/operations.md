# SheJane 运维手册

SheJane 只有 Client 与 Runtime 两个产品模块；Runtime 目录同时拥有公共 Runtime SDK 和插件，默认不读取根目录环境变量。

## 本地开发

首次安装：

```bash
make setup-hooks
corepack enable
pnpm install
cd runtime && uv sync
```

启动完整开发栈：

```bash
make dev
```

该命令启动源码 Runtime、Vite 和 Electron。

两个模块也可以独立运行：

```bash
make dev-runtime                     # 只启动 Runtime
make dev-client                      # 只启动 Client，使用 SHEJANE_RUNTIME_URL 与 SHEJANE_RUNTIME_TOKEN
cd runtime && uv run shejane-runtime --help
```

常用排障：

```bash
make doctor
make restart-runtime
make logs-runtime
```

## Runtime 配置

Runtime 默认不要求用户环境变量。

- Client Main 启动托管 Runtime 时，通过命令行传入本机地址、随机端口和配对 Token。
- Client 不提供 Runtime 连接设置。开发者接入外部 loopback Runtime 时，地址与 Token 由 Electron Main 配置和保存，不回传明文 Token 给 Renderer。
- 模型供应商、模型资料和高级默认设置通过 Runtime API 保存。
- BYOK 密钥写入操作系统凭据库，不写入 SQLite、Run 快照或环境变量。
- `--data-dir` 可以修改 Runtime 数据目录。

开发和测试可以使用 `SHEJANE_FAKE_LLM`、tracing 变量以及 Skills/MCP 路径覆盖，但这些不是用户安装配置，也不提供公开 `.env.example`。

## 添加 BYOK 供应商

Client 的模型供应商设置会调用 Runtime 的 `/v1/model-providers` 接口。当前生产适配器支持 OpenAI 兼容接口和 Anthropic 原生接口。

Client 提供 OpenAI、OpenRouter、DeepSeek、Anthropic、自定义 OpenAI 和自定义 Anthropic 入口。填写 API Key 后，Runtime 会从供应商的模型目录读取模型；Client 会显示可搜索的列表，并允许为同一个供应商勾选多个模型。手动填写时使用“+”增加模型输入框。上下文上限收在高级设置中，模型默认启用流式输出和工具调用。

供应商的模型目录通常不包含可靠的图片能力信息。每个模型因此默认标记为“仅文本”；只有供应商文档明确说明模型支持图片输入时，才在模型设置中开启“支持图片”。模型选择器会显示该能力。文本模型读取图片时，Runtime 会返回明确的能力限制，不把图片内容交给模型猜测。

任务使用明确的 `local:<供应商编号>:<模型编号>`。Runtime 不自动选择模型或静默切换供应商。

## 自动审批

Client 新对话默认使用“自动审批”。Runtime 会先执行确定性安全规则，只把外部或未知灰区交给当前 Run 已冻结的具体模型；审查器没有工具，也不能授予插件 capability、扩大工作区或绕过沙箱。审查超时、供应商失败、无效 JSON 或不完整决定都会回退到人工审批，不会自动放行或切换模型。

审查调用和主 Agent 使用同一持久模型账本，但记录为独立的 `approval_review` purpose 和预算。自动决定保存在 Tool Receipt；诊断时可以通过 Run diagnostics 查看 `review_source`、`review_reason` 和 `review_model`。Client 时间线中的“规则自动允许”表示固定策略决定，“智能自动允许”表示当前模型决定。

## 插件安装与信任

Runtime 接受单个 `.shejane-plugin` ZIP，通过 `plugin.install` Command 安装到数据目录下的内容寻址存储：

```text
<data-dir>/plugins/packages/<sha256>
```

来源 ZIP 只用于限额解包和校验，Runtime 不从来源路径直接执行文件。安装、启停、更新、回滚和移除都写入现有 Command 日志；移除先标记 retired，不立即删除旧版本字节。

未签名包必须由调用方显式提交 `allow_unsigned=true`。签名包使用部署方维护的只读信任文件：

```text
<data-dir>/plugins/trusted-publishers.json
```

```json
{
  "schema_version": 1,
  "keys": [
    {
      "publisher_id": "com.example",
      "key_id": "ed25519:sha256:<64 lowercase hex characters>",
      "public_key": "<base64 raw 32-byte Ed25519 public key>",
      "status": "trusted",
      "not_before": "2026-01-01T00:00:00Z",
      "expires_at": "2027-01-01T00:00:00Z"
    }
  ]
}
```

同一 publisher 可以保留多把 key 进行轮换。将 `status` 改为 `revoked` 会阻止后续安装；签名有效只证明来源和完整性，不授予额外文件、网络或执行权限。

官方或第三方插件都以 `.shejane-plugin` 文件分发。用户下载、接收或自行构建后，从 Plugin Tab 本地导入；Runtime 不维护远程插件来源、索引或来源公钥。官方必要插件可以随应用提供，但仍使用相同的包格式、安装记录和运行约束。

`@anthropic-ai/sandbox-runtime@0.0.65` 只保留为旧路径和对照测试，不是 Linux 完整 backend。Linux 使用随 Runtime 冻结的 Bubblewrap 0.11.2、原生 launcher、seccomp、私有 tmpfs、Artifact broker 与 delegated cgroup v2；macOS arm64 使用下述短命 VM。任何旧 SRT 路径都只能证明 access layer，不会自动得到 `resource_isolated=true` 或 `sandboxed=true`。

macOS arm64 VM 资产集由 `client/vm-assets/build_darwin.py` 构建。生成器只接受 lock 中精确大小与 SHA-256 的 Fedora 44 已签名 kernel RPM/SRPM、Fedora keyring、e2fsprogs 1.47.2 源码/签名和固定 kernel.org OpenPGP key；它验证 RPM 身份与签名、源码签名、Xcode/Clang/SDK/Go 工具链，确定性生成 Linux Image、guestd initramfs、host-native `mke2fs`、带 `com.apple.security.virtualization` entitlement 的 launcher、许可证、SPDX SBOM 和 canonical manifest。两次完整构建已经逐字节一致。

Electron Builder 用 `build/vm-assets-arm64` 把完整资产集放入 `Contents/Resources/sandbox/vm-assets`。资产集中的 Mach-O 在生成 manifest 前完成签名，打包时跳过整套只读资产，最终由最外层 App 签名封存；最终 `.app` 内的资产与构建输出逐字节一致。发布 workflow 在凭据完整时执行 Developer ID、Hardened Runtime、secure timestamp、App Store Connect API key 公证、staple、Gatekeeper 与 nested-code 验证；凭据全部缺失时只生成明确标记的 ad-hoc 签名预览包，凭据只配置一部分则 fail closed。只有 Developer ID/公证路径在原生 runner 上真实通过后，才能移除最后的 `release_ci_gate`。

Client 在 Darwin 上把包内 `sandbox/vm-assets/manifest.json` 作为显式 CLI 参数交给 Runtime；不存在系统路径或 `$PATH` fallback。P6 只有在冻结 lease 含 Managed Worker 时加载一次该资产集，并按 [`managed-worker-vm-assets-v1.schema.json`](../runtime/plugins/schemas/managed-worker-vm-assets-v1.schema.json) 对 host/guest 架构、协议、canonical asset-set ID、HTTPS 来源、普通文件、无 symlink、size、SHA-256 和 executable bit 做 fail-closed 预检。打包门禁还会调用包内 Runtime 的 `--validate-managed-worker-vm-assets`，在启动 Client 前执行同一生产 preflight，防止 schema 过期或资产被替换的包通过 lifecycle smoke。预检通过只代表资产身份成立，不会绕过平台 release Gate。

macOS VM 黑盒 Gate 是 `runtime/tests/test_macos_managed_worker_vm_gate.py`。发布工作流必须用 `SHEJANE_TEST_MACOS_VM_ASSETS` 指向最终 `.app` 内的绝对 manifest 路径；测试由生产 preflight 加载精确包内资产，并直接调用生产 Executor。Gate 覆盖成功、显式失败、非法 JSON、取消、hostile symlink、超限 Artifact、scratch `ENOSPC`、invocation 私有且 scratch-backed 的 `/tmp`、`/tmp` noexec、只读 rootfs、descendant OOM 和 PID exhaustion，并验证 cgroup 与 invocation staging 清理。开发态仍保留 kernel/modules/`mke2fs` 分项探针，但缺少资产导致的 skip 不算发布证据。

这仍不代表 Managed Worker 已开放：`darwin/arm64` 已证明冻结资产集、完整包内 launcher、生产 manifest preflight，以及静态 Linux Worker 的包内 14-mode VM 往返；Worker 与 descendant 均无法访问宿主文件、凭据、进程、Unix socket、宿主 loopback 或外网，Worker/launcher 崩溃会清理 VM staging，Runtime 被 `SIGKILL` 后也由可继承 `flock` lease 在 launcher 退出后安全回收孤儿目录。最终 `.app` 还已从正常 Client 入口建立带 token 的 P1 Runtime 会话，核对 Main 注入同一包内 VM manifest，并通过 `app.quit` 证明 bundled Runtime 随应用退出。Linux/arm64 Debian 只读 rootfs 现由固定 OCI manifest 与 e2fsprogs 1.47.2 确定性构建；真实 PyInstaller onedir Worker、内容寻址 Node.js 24.18.0 LTS Runtime Asset、共享 Office Runtime Asset 和独立 MuPDF Runtime Asset 均已在 VM 内以 UID/GID 65534 完成协议往返。Node 主动验证 Runtime Asset 只读；Office 覆盖 Writer/Calc/Impress rich golden，PDF 覆盖 Unicode、无文本层、精确 PNG golden、hostile corpus 与中途取消清理。上述动态证据已接入最终包内 release workflow，但真实 Developer ID/公证 runner 尚未运行，因此只保留 `release_ci_gate`，Registry 继续关闭。`darwin/amd64`、Windows 和 Linux 各自保持独立 fail-closed。签名或用户确认不能绕过对应平台门槛。

原生 Linux Runtime 现包含可复现构建的 Bubblewrap 0.11.2、`shejane-managed-worker-linux` 和匹配的 `libcap`。P6 只接受绝对的包内 manifest，并逐文件核对 size/SHA-256、普通文件、无 symlink 和 executable bit；随后从 `/proc/self/cgroup` 找到带 `user.delegate=1` 的 systemd 父级，要求 Runtime 已位于 `DelegateSubgroup=`，并启用、回读 `cpu`、`memory`、`pids` controller。普通 `/sys/fs/cgroup`、系统 `$PATH` 中的 bwrap 和未委托 scope 都会 fail closed。

Linux launcher 用 `CLONE_INTO_CGROUP` 原子启动 Worker，组合只读 root/package/input、空网络/PID/IPC/UTS namespace、按架构 seccomp、计入 cgroup memory 的定容私有 tmpfs，以及只复制声明 Artifact 的 host broker。当前 Docker Desktop Linux/arm64 真实 Gate 已通过文件、凭据、宿主 PID、Unix/TCP/外网隔离、只读路径、禁止嵌套 user namespace、scratch `ENOSPC`、内存耗尽、忽略取消的 descendant 清理与 leaf 回收。发布 workflow 还会在最终 PyInstaller 资产上通过 `systemd-run` 的 `Delegate=yes`、`DelegateSubgroup=supervisor` 重跑同一组测试；该 workflow 尚未真实成功，因此 `systemd_delegation_gate` 和 `release_ci_gate` 仍关闭，非受信任 Worker 仍不得启用。

Office 插件使用内容寻址、平台专用的 LibreOffice/MuPDF Runtime Asset，不探测用户安装的 Office。macOS arm64 的实际 execution platform 是 `linux/arm64`：当前 Linux Asset 固定 LibreOffice 25.8.7、MuPDF 1.27.2 和 Noto Sans CJK 2.004，验证 LibreOffice OpenPGP 签名和所有输入摘要，离线双构建 `mutool`，两次完整 Asset 归档逐字节一致。Documents、Spreadsheets 与 Presentations 的 Linux/arm64 onedir Worker 和插件包也已确定性构建，并通过生产 VM 中的 DOCX 两页/CJK、XLSX 公式重算/日期/区域格式/图表、PPTX CJK/表格/图片 rich golden。发布 workflow 会用最终 `.app` 内的 VM manifest 重跑这三项；真实 Developer ID/公证 runner 尚未成功执行，`release_ci_gate` 仍关闭，所以 Office 仍不能宣称为已发布产品能力。

Media Foundation 现在有真实 `linux/arm64` 执行候选：`org.ffmpeg.runtime` 从已验证签名的 FFmpeg 8.1.2 源码构建，冻结 Debian OCI/toolchain/package closure，禁用网络、GPL 与 nonfree，并携带源码、签名证据、许可、SBOM 与 provenance。两份完整 Asset 归档逐字节一致（archive `1a8e20a1...e93`，canonical asset `sha256:64026538...4d55`）；冻结 onedir Worker 已在生产 VM 中通过 probe、精确缩略图/抽帧/音频 hash、hostile corpus、取消无部分输出和重放。全部 Gate 已接入最终 `.app` release workflow，但真实签名/公证 runner 尚未运行，因此仍不是已发布产品能力；其他平台需独立资产与 Gate。详见 `docs/plugins/phase6-media-foundation-research.md`。

PDF 插件现在有 `linux/arm64` 真实执行候选：独立 `org.mupdf.runtime` 从固定 SHA-256 的官方 HTTPS MuPDF 1.27.2 源码构建（上游未提供与 FFmpeg 相同的 PGP 验证流程），冻结 Debian OCI/toolchain/package closure，离线双构建，并携带完整对应源码、许可、SBOM 与 build provenance。Asset 归档逐字节一致；冻结 onedir Worker 已在 macOS arm64 的生产 VM 中通过 inspect、Unicode 页窗文本、无文本层 OCR 标记、精确选页 PNG golden、hostile/truncated corpus、中途取消无部分输出和取消后重放。发布 workflow 会在最终签名/公证 `.app` 的 VM 中重跑全部门禁；真实 release runner、Linux amd64、Windows 尚未完成，所以仍不是已发布产品能力。详见 `docs/plugins/phase6-pdf-research.md`。

OCR 现在也有真实 `linux/arm64` 候选：`org.rapidocr.runtime` 固定 RapidOCR 3.9.1、ONNX Runtime 1.27.0、PP-OCRv6 medium、CPU 单线程和三个精确模型，离线构建并拒绝 Tesseract/Leptonica。完整 Asset 双构建一致（archive `c2e86a0a...23cb`，canonical asset `sha256:5a11d711...b148`）；冻结 Worker 已在生产 VM 中通过确定性重放、中英文、低对比度、多栏、手写风格、180° 方向、hostile 图片、取消无部分输出和取消后重放。最终 `.app` workflow 已接入但尚无真实签名/公证执行证据；日文/真实手写广度及其他平台仍需独立 Gate，所以 Registry 继续关闭。详见 `docs/plugins/phase6-ocr-research.md`。

Speech 现在有真实 `linux/arm64` 候选：`speech.transcribe` 固定 `whisper.cpp 1.8.6`、`large-v3-turbo Q5_0`、CPU 单线程 greedy，并复用精确 FFmpeg 资产做 16 kHz 单声道 PCM 归一化。官方 checkpoint 转换/量化模型 SHA-256 固定为 `39422170...a7e2`；两份 525 MiB Asset 完全一致（archive `883900b6...5cdd`，canonical asset `sha256:dc6ec9da...4f11`）。生产 VM 已通过重复转写/Artifact hash、显式中英文、带背景噪声/双音干扰和四秒停顿的日文 `auto`、66.7 秒且 45% 音量的印度英语技术长文、hostile 音频、取消清理、300 秒双运行预算，以及真实 Media→Speech 文件 Artifact 组合；引擎报告 7,200,001ms 会在 Artifact 创建前拒绝。专名仍可能误识别，`initial_prompt` 不提供词典保证；真实音乐、混合语种/拉丁文字、真实编码两小时边界及过量输出仍待补。最终 `.app` workflow 已接入但真实签名/公证 runner 尚未运行，因此不得宣称为已发布能力。详见 `docs/plugins/phase6-speech-research.md`。

Cloud Vision 已形成 `linux/arm64` release candidate：管理员先配置明确支持 `image_inputs` 的 Runtime 模型，再通过幂等 `plugin.model.bind` 把具体 `local:<provider>:<model>` 绑定到 `org.shejane.vision.cloud`；未绑定时拒绝启用。绑定在 Run 接纳时冻结；冻结 onedir Worker 只能对授权图片发起一次有界 `model.vision.invoke`，不获得密钥、base URL 或网络。Worker 双构建一致、确定性包已检查（digest `sha256:33ff82dc...381f8`），并在生产 VM 中通过 host-call bridge；Runtime adapter 测试覆盖图片身份/预算、凭据脱敏、具体模型和规范化 usage。最终 `.app` workflow 已接入但真实签名/公证 runner 尚未运行，所以 Registry 继续关闭。Local Vision 仍保持拒绝：`llama.cpp b10025 + SmolVLM2 500M Q8_0` 虽可复现，但质量 Gate 仅 3/5，中文与图表失败；不得发布、不得回退到聊天模型。详见 `docs/plugins/phase6-vision-research.md`。

插件大文件不会写进 SQLite。Run 接纳附件时把正文流式导入：

```text
<data-dir>/inputs/sha256/<prefix>/<digest>
```

文件 Artifact 的目录是：

```text
<data-dir>/artifacts/sha256/<prefix>/<digest>
```

SQLite 只保存授权关系、逻辑大小、摘要和内部 body key。启动时会有界清理超过一小时、没有目录记录引用的孤儿正文；存在目录记录但正文丢失时会按损坏状态失败，不会盲目重跑可能有副作用的 Action。内联文本上限 32 MiB；文件 Artifact 上限为单项 2 GiB、单 Run 4 GiB、单 principal 16 GiB、本机总计 64 GiB。

## 构建 Runtime

Runtime 暂不单独发布二进制文件。请在目标操作系统和 CPU 架构上从源码构建：

```bash
make package-runtime
```

构建结果位于 `runtime/dist/shejane-runtime/`。其中包含平台相关的原生依赖，不能用于其他操作系统或 CPU 架构。

## 发布

公开发布使用两个标签：

```text
client-vX.Y.Z
runtime-sdk-vX.Y.Z
```

Client CI 在两个原生 runner 上分别构建 Runtime 和安装包：

```text
client-macos-arm64
client-windows-x64
```

macOS 正式分发必须配置以下全部 GitHub Actions secrets：

- `MACOS_DEVELOPER_ID_P12_BASE64`：Developer ID Application `.p12` 的 base64；
- `MACOS_DEVELOPER_ID_P12_PASSWORD`：该 `.p12` 的密码；
- `APPLE_API_KEY`：App Store Connect API `.p8` 的 base64；
- `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`。

全部凭据存在时，发布 job 会验证 `.app` 与 DMG 的 staple ticket、Gatekeeper、Hardened Runtime、secure timestamp、Developer ID、VM launcher entitlement、包内 manifest 身份和完整 VM Gate。全部凭据缺失时仍会生成 ad-hoc 签名、未公证的预览 DMG/ZIP，并继续验证包内 Runtime、VM 资产和功能 Gate；这种产物会触发 Gatekeeper 警告，且不构成 `release_ci_gate` 的发布证据。凭据只配置一部分会 fail closed。配置依据见 [electron-builder macOS signing](https://www.electron.build/mac/)、[electron-builder notarization](https://www.electron.build/docs/notarization/) 与 [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。

手动运行 Client 发布工作流只生成 GitHub Actions 产物。推送 `client-vX.Y.Z` 标签才会创建 GitHub Release。

正式 Client 安装包必须：

- 从同一次提交构建并内置对应平台和架构的 Runtime；
- 固定并内置 Managed Worker sandbox launcher，且在该原生安装包上通过 descendant conformance；
- 只停止 Electron Main 自己启动的 Runtime，不停止外部 Runtime。

## 验证

```bash
make lint
make test
make build
make test-e2e
git diff --check
```

`make test-contract` 会验证真实 Runtime HTTP/SSE 与 SDK，且不启动 Electron。`make test-e2e` 在此基础上继续执行进程恢复、官方 MCP client conformance 和 Playwright Electron 关键路径。详细范围见 [Runtime 端到端测试](./runtime-e2e-testing.md)。

发布前还应确认：

- 清空用户环境变量后，Client 和 Runtime 可以启动；
- BYOK 模型能够完成“模型 → 工具 → 模型”；
- 仓库没有根 `.env.example`、模块 `package-lock.json` 或旧目录引用；
- Client 源码只连接 Runtime；
- Client 安装包包含由同一次提交构建的 Runtime。

## 安全边界

- Runtime 只监听 loopback；远程连接必须经过未来的独立网关，不能直接暴露 Runtime。
- 不要打印或提交任何 `.env`、Token 或 BYOK 密钥。
- 不要增加产品私有的会话、模型或工具网关。
- 外部能力通过标准模型供应商或 MCP 接入。
