# 桌面客户端分发方案(本地 Agent 优先)

> 把 Python LangGraph daemon 打包进 Electron,产出**可签名分发**的 macOS / Windows 桌面应用。
> 本文是路线图 + 决策记录;实现按 Phase 推进,每个 Phase 都产出可测产物。

## 为什么需要桌面版

服务器上的 `client` 容器(`https://app.shejane.com`)是 **Web 版**,在浏览器里跑、**没有本地 daemon** → 只有云聊天,没有本地 Agent 工具(文件系统、本地执行、浏览器自动化)。本地 Agent 是产品核心,而它依赖 `local-host/python` 这个 FastAPI/uvicorn daemon 在用户机器上的环回端口运行。`release.yml` 只构建 3 个服务器镜像、**明确不含 daemon**。因此桌面分发是一条独立的工程线。

## 目标架构(端到端)

每平台一个签名+公证的安装包(mac arm64 `.dmg`、mac x64 `.dmg`、Windows x64 NSIS `.exe`),内含 Electron 壳 + **PyInstaller 冻结的 daemon**(放在 `extraResources`,不进 asar)。

> **系统要求(Windows):Windows 10 或更高(仅 64 位)。** 本应用基于 **Electron 33**,而 **Electron 23 起已彻底移除 Windows 7/8/8.1 支持**(最后一个支持 Win7 的大版本是已 EOL 的 Electron 22)。因此 NSIS 安装包通过 `build/installer.nsh` 在 `< Win10` 上**直接拒绝安装并给出中文提示**,避免老系统上"装得上、打不开"+ 创建快捷方式报"未指定的错误"的困惑。**不提供 32 位(ia32)构建** —— 现代 Windows 基本都是 64 位。若未来要支持 Win7,只能单独维护一条 Electron 22 旧版构建线(EOL、无安全补丁,需评估风险)。

启动流程(`client/electron/main.cjs`,在开窗前完成 —— 把现在只在 `scripts/dev-electron.sh` 里的逻辑搬进来):

1. 选一个空闲环回端口(`net.createServer().listen(0)`,不再硬编码 17371)。
2. 生成**一次性随机配对 token**(`crypto.randomBytes(32).toString('hex')`)。
3. `child_process.spawn` 冻结的 daemon(`process.resourcesPath/local-host/shejane-local-host[.exe]`),**scrubbed 环境**:
   `SHEJANE_LOCAL_HOST_ADDR=127.0.0.1`、`SHEJANE_LOCAL_HOST_PORT=<freePort>`、`SHEJANE_LOCAL_HOST_TOKEN=<token>`、`SHEJANE_CLOUD_BASE_URL=https://app.shejane.com`、`PYTHONUNBUFFERED=1`、`PATH/HOME/TMPDIR` —— **绝不转发任何 provider 密钥**(Invariant #1)。
4. Electron Main 保管 `SHEJANE_LOCAL_HOST_TOKEN`，并只对目标 Runtime 地址注入认证头；`preload.cjs` 仅把 URL 和不含秘密的桌面会话标记交给渲染层。
5. 轮询 `GET /local/v1/health`(免鉴权路径)直到 200,期间显示 splash;超时弹 `dialog.showErrorBox`。
6. `loadFile(dist/index.html)`。

退出时**强杀**:POSIX `SIGKILL` 进程组 / Windows `taskkill /T /F`(uvicorn 吞 SIGTERM,见 CLAUDE.md Invariant #4)。绑到 `before-quit/will-quit`,**不是窗口关闭**(本应用关窗=隐藏到托盘)。可写状态在 `~/.shejane`,只读签名包不被写。

## 关键现实(调研 + 对抗验证确认,会改变做法)

1. **必须冻结、且每个 OS+架构单独构建。** 依赖树全是平台相关原生 wheel(pydantic-core/lxml/cryptography/onnxruntime/tiktoken/pillow),交叉构建会在用户机 import 时崩。CI 必须用原生 runner:`macos-14`(arm64)、`macos-13`(x64)、`windows-latest`(x64)。
2. **🔴 v1 把 browser-use + playwright 移出冻结环境。** `builder.py` 仍把 `browser_llm=None` 写死，未接线时 `browser.task` 不会暴露给模型；如果直接冻结 browser-use/playwright，会白塞 ~140M+ 死代码（googleapiclient 93M、pandas 48M、多个多余 LLM SDK）还得扛 Chromium 签名。做法：把 `browser-use`/`playwright` 保持在 `[project.optional-dependencies]`，冻结环境不装；等以后接 `browser_llm` 再单独做浏览器打包（bundle Chromium 进 extraResources + `PLAYWRIGHT_BROWSERS_PATH` + 签名）。
3. **🔴 onnxruntime 必须显式收集。** 它(111M,经 `markitdown → magika`)在 `office.py` 模块级 `MarkItDown()` 构造时**开机即加载**。`.spec` 必须 `--collect-all onnxruntime magika`、装 `pyinstaller-hooks-contrib`,否则用户一启动就 import 崩(最坏的失败模式)。建议把 office 工具改懒加载,onnxruntime 首次用才加载,缩短冷启动 + 降低风险面。
4. **`.spec` 还要处理动态 import**:`--collect-all langgraph langchain langchain_core deepagents markitdown`、`--copy-metadata`、`--hidden-import uvicorn.loops/uvicorn.protocols/uvicorn.lifespan`。**冒烟必须跑一次真实 agent loop**(不能只 curl /health),否则漏 import 的崩溃只在运行时暴露。
5. **macOS 双架构**:每架构原生 wheel → 出**两个 arch-specific DMG + 各自更新源**(electron-builder 单 `latest-mac.yml` 对双架构是已知坑)。universal2 因 Python 原生 wheel 难合并,不走。
6. **两个 base URL 必须一致**:渲染层 build 时的 `VITE_API_BASE_URL` 与主进程 `apiBaseURL()` 都要 = `https://app.shejane.com`,否则 auth cookie 与数据请求绑到不同源 → 登录态静默失效。
7. **冻结后包体**(去掉 browser-use 后)约 250–400MB/平台。差量更新(blockmap)对 v1 基本无用(每次发布 Python 树都变)→ v1 用**全量替换**自动更新。

## 硬性前提(绕不过,需提前准备)

| 项 | 说明 | 成本 |
|---|---|---|
| Apple Developer Program + Developer ID Application 证书 | macOS 公证必需(hardened runtime + notarytool + staple),否则用户打不开 | $99/年 |
| Windows 代码签名 | Microsoft Artifact Signing(CI 友好、无硬件 token;US/CA/EU/UK 主体或 US/CA 个人可申,已取消"满 3 年"要求)或 OV 硬件 token 证书 | ~$10/月起 |
| 原生 CI runner | GitHub Actions:macos-14 / macos-13 / windows-latest | 自带 |

注:Windows SmartScreen 对新应用有"信誉冷启动"期(签名也要攒口碑,EV 自 2024 年起不再跳过);保持**单一稳定签名身份**,并对早期用户做预期管理。

## 分阶段计划

| 阶段 | 目标 | 量级/风险 | 交付 |
|---|---|---|---|
| **0 生产配置** | 渲染层 + 主进程都指向 `https://app.shejane.com` | S/低 | 连生产云的构建,dev 可验证登录/云调用 |
| **1 electron-builder 骨架** | 打包+(后续)签名链路跑通的"壳"(云聊天可用,本地 agent 还没有) | M/中 | 可安装的 `.dmg`/`.exe`,连生产 API |
| **2 冻结 daemon + 主进程拉起**(核心) | PyInstaller onedir + main.cjs spawn/端口/token/health/强杀 | XL/高 | **本地 agent 能跑**的桌面包 |
| **3 浏览器工具** | v1 隐藏未接线工具（不打 Chromium）；文档化后续接入 | M/中 | v1 不含 Chromium、启动不崩、模型看不到死工具 |
| **4 签名 + 公证** | macOS hardened runtime+entitlements+公证;Windows 签名 | L/高 | 过 Gatekeeper 的 mac 包 + 签名 Win 包 |
| **5 自动更新 + CI 发布** | `release-desktop.yml` 原生矩阵 + electron-updater 全量替换 | L/高 | tag 触发、自动签名公证发布 |

### Phase 0 — 生产配置
- 新增 `build:desktop` 脚本:`tsc -b && cross-env VITE_API_BASE_URL=https://app.shejane.com vite build`(**不复用** web 的 `pnpm build`,后者被 Docker 用空 `VITE_API_BASE_URL` 构建成同源)。
- `main.cjs` `apiBaseURL()` 在 `app.isPackaged` 时默认 `https://app.shejane.com`(原来默认 localhost:8080)。

### Phase 1 — electron-builder 骨架
- `package.json` 加 `main: electron/main.cjs`、devDeps `electron-builder` + `cross-env`、脚本 `dist` / `dist:dir`。
- `client/electron-builder.yml`:`appId: com.shejane.desktop`、`productName`、`files`(dist + electron/*.cjs + assets)、`mac.target [dmg, zip]`、`win.target nsis`、图标复用 `electron/assets/app-icon.icns`(mac)+ `app-icon.png`(win 自动转 .ico)。
- 先出 unsigned/ad-hoc 产物验证构建,再接 Developer ID 签名(壳很小,先在小包上验证签名身份)。

### Phase 2 — 冻结 daemon + 主进程拉起(核心里程碑)
- `local-host/python/shejane-local-host.spec`:onedir(**不能 onefile** —— 破坏 uvicorn 信号处理 + 每次启动重解压),collect/hidden-import 见「关键现实 3、4」。
- 新 `make build-daemon`(`uv run pyinstaller`)。electron-builder `extraResources` 把 onedir 放到 `process.resourcesPath/local-host`。
- main.cjs 实现完整生命周期(见「目标架构」)。
- 冒烟:安装 → 登录 → 跑一次 SSE run(`POST /local/v1/runs` → stream)+ 一个网关计费工具(web.search),验证 daemon→cloud 代理 + JWT-via-`/local/v1/session`。

### Phase 3 — 浏览器工具
- v1：browser-use/playwright 不进冻结环境；daemon 不暴露 `browser.task`，除非未来显式接入 browser LLM。
- 后续:build 时 `playwright install chromium` 进已知目录 → `extraResources` → runtime 设 `PLAYWRIGHT_BROWSERS_PATH`;Chromium 的 Mach-O/Helper 也要签名 + JIT entitlements。

### Phase 4 — 签名 + 公证
- macOS:`hardenedRuntime: true`;entitlements 含 `com.apple.security.cs.allow-unsigned-executable-memory`(PyInstaller 内嵌 CPython 必需);接入 Chromium 后再加 `allow-jit` + `disable-library-validation`。`mac.binaries` 枚举内层 Mach-O 逐个签;afterSign 钩子用 **notarytool**(非废弃 altool)submit + staple。**一个没签的内层 Mach-O 就整体公证失败**(报错模糊),最耗时。
- Windows:每次发布用**同一**签名身份。

### Phase 5 — 自动更新 + CI 发布
- electron-updater;`app.isPackaged` 时 `checkForUpdatesAndNotify()` + `quitAndInstall()`。**全量替换**(daemon 随 app 版本原子更新,无独立后端更新通道);v1 不做差量。
- 新建 `.github/workflows/release-desktop.yml`(**不**改 release.yml):矩阵 macos-14/macos-13/windows-latest;每个 runner:setup Python 3.12 + uv → `make build-daemon` → `build:desktop` → electron-builder(签名/公证 secrets)→ 发布到 GitHub Releases(`latest*.yml` + 安装包)。

## 安全模型

- **仅环回**:`SHEJANE_LOCAL_HOST_ADDR` 保持 `127.0.0.1`,main.cjs 不得改成 0.0.0.0。
- **一次性配对 token**:dev 的 `dev-local-token` 不能 ship;打包版每次启动随机生成，只存在于 Electron Main 和 daemon 的 spawn 环境，**不进入 Renderer、不写日志/磁盘**。daemon 经 `PairingTokenAuthMiddleware` 强制(空 token → 非 health 全 503;不匹配 → 401)。
- **Invariant #1**:daemon spawn env 是 scrubbed 的(选择性转发,镜像 `dev-electron.sh` 的 `env -i`),不含任何 OpenAI/Tavily/Anthropic/E2B/AWS/Stripe 密钥。daemon 仅作代理:LLM 经 `{cloud}/api/v1/agent/llm/stream`、平台付费工具经 `{cloud}/api/v1/agent/tools/execute`,都带用户 JWT(经 `POST /local/v1/session` 运行时下发)。`scripts/check-no-platform-keys-in-daemon.sh` 在 lefthook + CI 兜底。

## 最大风险

1. **PyInstaller 漏动态 import → 用户启动即崩**(langgraph/markitdown/onnxruntime/uvicorn)—— 靠"冻结后跑真实 agent loop"的 CI 冒烟兜底。
2. **macOS 公证全有或全无** —— 单个未签嵌套 .so 整体失败,报错模糊。
3. 包体 250–400MB/平台,影响 CI 时间/存储/更新下载;NSIS 差量更新脆弱(v1 用全量)。
4. 每 OS+架构必须原生构建,wrong-arch wheel 在 import 时才崩 —— 每个产物都要在目标 OS 上 smoke-launch。

---

实现进度见各 Phase 的 commit;本文随实现更新。
