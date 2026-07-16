# Managed Worker：Windows 与 Linux 强隔离研究

> 调研日期：2026-07-16
>
> 资料范围：Codex、Pi、LangGraph、Deep Agents 官方文档与官方源码；Microsoft Windows 官方文档；Linux Kernel、Linux man-pages、systemd 与 bubblewrap 官方文档。
>
> 目标：判断 Windows、Linux 上执行任意来源 `managed_worker` 时，哪些方案能证明文件、网络、进程树、内存、CPU、磁盘、取消与清理 Gate。本文只冻结实现方向，不把“API 存在”写成“发布 Gate 已通过”。

## 结论

**没有一个现成 Agent 库同时完成 SheJane 在 Windows 与 Linux 上要求的访问隔离、硬资源配额和可审计清理。**

- Codex 的 Linux sandbox 是很好的 bubblewrap、namespace、seccomp 与文件策略参考；其 Windows 实现使用专用用户、ACL、WFP、restricted token 和 Job Object，但当前 Job 只设置 `KILL_ON_JOB_CLOSE`，没有 Worker 级内存、CPU 或进程数配额。
- Pi 的 extension 在宿主中以用户完整权限运行；官方 sandbox 只是替换 `bash` tool 并调用旧版 Sandbox Runtime，不隔离 extension 自身，也没有资源 Gate。
- LangGraph 是图编排与持久化 Runtime，节点就是普通 Python 函数；它不提供本地不可信代码的 OS sandbox。
- Deep Agents 定义了可替换 sandbox backend，但强隔离由 Daytona、Modal、Runloop、AgentCore、LangSmith 等 provider 提供，不是可随 SheJane 打包的本地 Windows/Linux launcher。

因此冻结以下方向：

1. **Windows 不执行原生第三方 Worker。** AppContainer/Job 不能在普通用户权限下给目录施加硬容量上限，VHDX attach 又需要宿主存储权限。最终候选改为 LPAC/Job 包裹的 QEMU Linux MicroVM：WHPX 负责可选硬件加速，TCG 负责无系统功能依赖的兼容执行，Guest 固定容量块设备负责 scratch。
2. **Linux 继续使用 bubblewrap/SRT 访问层 + cgroup v2 资源层 + 有界私有 tmpfs。** Landlock 只做 defense-in-depth，不能替代 mount/network namespace、seccomp 或 cgroup。
3. **Windows Sandbox 不作为 Managed Worker Adapter。** 它的 VM 边界足够强，但 SKU、可选功能、交互式生命周期、单实例和无进程 I/O 等限制与 Worker JSON-RPC 不匹配。
4. **Windows 先复用现有 Linux Guest 契约，不新建 Windows Worker ABI。** 当前没有 Windows 真机，Windows 继续停留在设计与 fail-closed 状态；只先提交跨平台 ABI/Release Gate 决策与可在本机验证的 media builder。

## Runtime 阶段

```text
主要阶段：P6，绑定资源并取得 Agent 定义
上游输入：P5 冻结的插件版本、digest、输入引用、能力与 limits
下游执行：P10 Action 调用平台 isolation adapter
下游清理：P11 证明 Job/cgroup、进程树、mount、pipe 和 scratch 已回收
最终提交：P12 只提升 Runtime 重新校验后的 Artifact
状态所有者：Runtime PluginRegistry、ManagedWorkerAdapter、P10 receipt、P11 cleanup lease
替换路径：普通子进程监督；它只有故障边界，不是权限或资源沙箱
```

## 1. Agent 实现对比

### 1.1 OpenAI Codex

Codex Linux 当前优先使用 bubblewrap：根文件系统默认只读，按策略重挂可写根，显式创建 user/PID/network namespace，设置 `PR_SET_NO_NEW_PRIVS`，并在进程内安装 seccomp 网络过滤器。WSL1 因不能创建所需 user namespace 而拒绝进入 bubblewrap 路径；WSL2 使用正常 Linux 路径。这证明 launcher 必须先做宿主能力 preflight，并在能力缺失时 fail closed。[Codex Linux sandbox README](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/linux-sandbox/README.md)

Codex Windows 当前不是 AppContainer。Elevated 路径在专用 sandbox 用户下启动 runner，再派生 restricted token；网络由 elevated setup 写入持久 WFP filter，文件由 ACL 控制。[Codex Windows runner](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs) [Codex WFP source](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/windows-sandbox-rs/src/wfp.rs) [Codex token source](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/windows-sandbox-rs/src/token.rs)

当前 runner 的 Job Object 只写入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；源码没有设置 `JOB_OBJECT_LIMIT_JOB_MEMORY`、`JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 或 CPU rate。因此 Codex 可以作为访问层和进程清理参考，不能直接使 SheJane 报告 `resource_isolated=true`。[Codex Job setup](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs#L133-L149)

### 1.2 Pi

Pi 官方明确说明 extension 以用户完整系统权限运行并可执行任意代码；项目 trust 只决定是否加载项目资源，不把已加载 extension 放入 OS sandbox。[Pi extension security](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/docs/extensions.md#L109-L113)

官方 sandbox 示例只替换内置 `bash` tool，将命令交给 `@anthropic-ai/sandbox-runtime`；它没有隔离其它 extension 代码。示例还固定 SRT `0.0.26`，不能代表当前 SRT Windows Alpha 的行为，也没有内存、CPU、进程数或磁盘字段。[Pi sandbox extension](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/examples/extensions/sandbox/index.ts) [Pi sandbox dependency](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/examples/extensions/sandbox/package.json)

### 1.3 LangGraph

LangGraph 的官方定位是低层图编排 Runtime，核心能力是 durable execution、streaming、human-in-the-loop 和 persistence。Graph node 是同步或异步 Python 函数，可以直接产生任意副作用；官方 Runtime 没有本地文件、网络或资源 sandbox primitive。[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) [LangGraph node model](https://docs.langchain.com/oss/python/langgraph/graph-api#nodes)

结论：LangGraph 继续负责 SheJane 的 P7-P12 编排与恢复；Managed Worker 的隔离必须位于工具执行边界，不能把 graph checkpoint 或 timeout 当作 OS isolation。

### 1.4 Deep Agents

Deep Agents 的 sandbox backend 把 `execute()` 作为最小接口，文件操作可以建立在 sandbox 内的命令之上。官方方案列出的 Daytona、Modal、Runloop、AgentCore、LangSmith 等都是外部或托管 provider；文档也明确要求处理 TTL、主动 stop、网络外泄和 secret 风险。[Deep Agents sandboxes](https://docs.langchain.com/oss/python/deepagents/sandboxes)

这一设计证明 SheJane 的 `ManagedWorkerAdapter` 应保持 provider boundary，但它没有给出可直接随 Electron 应用分发的 Windows/Linux 本地实现。SheJane 不应把远程 provider 变成开源、本地优先产品的隐式依赖。

### 1.5 Anthropic Sandbox Runtime 的边界

SRT 当前是 Beta Research Preview。Linux 使用 bubblewrap；Windows Alpha 使用专用本地用户、WFP、NTFS ACL、restricted token 和 Job Object。[SRT README](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/README.md)

其 Windows Job 源码只证明 kill-on-close 和 UI restrictions，没有 Job memory、CPU rate 或 active-process limit；专用用户与 WFP 的安装还要求 elevation。SRT 可以复用为 Linux 访问层或实现参考，但 `initialize()` 成功不能设置 SheJane 的 `resource_isolated=true`。[SRT Windows Job](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/vendor/srt-win-src/src/job.rs) [SRT Windows user provision](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/vendor/srt-win-src/src/user.rs) [SRT Windows WFP](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/vendor/srt-win-src/src/wfp.rs)

## 2. Windows 决策

### 2.1 最终候选：LPAC/Job 包裹的 QEMU Linux MicroVM

AppContainer 对文件、注册表、credential、设备、网络、进程 kernel object 和窗口提供默认拒绝边界。LPAC 更严格，必须显式授予 capability。这里隔离的对象不是第三方 Worker，而是 QEMU VMM；即使 Guest 利用 QEMU 漏洞，VMM 仍没有宿主 profile、credential、网络或任意文件权限。[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) [Launch an AppContainer or LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

SheJane 候选启动顺序：

1. Runtime 生成只读 Rock Ridge package/input ISO 和固定长度空 RAW scratch，所有路径均位于 invocation-private staging。
2. 为 invocation 创建唯一 LPAC identity，只给 QEMU executable、冻结 VM assets、三张 invocation media 与两个 named pipe 必需的精确 ACL；不授予任何 capability。
3. 使用 `CREATE_SUSPENDED` 启动 QEMU，先放入不可 breakaway Job，再恢复主线程。Job 强制 kill-on-close、job memory、active-process limit 和 CPU hard cap。
4. QEMU 不创建 network device；rootfs/package/input 只读，scratch 只读写且 block file length 精确等于 `scratch_bytes`。
5. Guest 通过 Virtio serial named-pipe 通道完成 attestation、configure、Worker JSON-RPC、Artifact 回传、cancel 与 stopped；Worker 保持非特权 UID + cgroup v2 leaf。
6. Host 最后验证 Guest stopped、Job active process zero、Artifact digest、LPAC/ACL/media/pipe lease 清理。

Windows Job Object 支持进程树继承、不可 breakaway、job-wide memory、active-process limit、CPU rate、终止整个 Job 和资源 accounting。completion port 可以报告 memory/process limit 与 `ACTIVE_PROCESS_ZERO`；消息丢失不能单独作为成功证据，因此最终仍需查询 Job 状态。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) [Extended limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) [CPU rate control](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information) [Job completion port](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)

AppContainer/Job API 本身不要求 MSIX。`SECURITY_CAPABILITIES` 和 `CreateAppContainerProfile` 的官方最低客户端是 Windows 8，且文档没有列出 Home/Pro/Enterprise SKU 限制；SheJane 仍必须在每个支持 SKU 与架构上实测，而不能由 API 最低版本外推发布支持。[SECURITY_CAPABILITIES requirements](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-security_capabilities) [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)

### 2.2 为什么停止原生 Worker 路线

Job Object 不限制目录最终写入的总字节数。固定最大容量 VHDX 可以形成硬上限，但 `AttachVirtualDisk` 要求 `SeManageVolumePrivilege`；这不是普通 Electron 用户进程可以默认取得的权限。[AttachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk) [CreateVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-createvirtualdisk)

原生 AppContainer Worker 没有可接受的普通用户硬磁盘额度：Job Object 不限制目录，VHDX attach 需要 `SeManageVolumePrivilege`，宿主 free-space 轮询、写入后检查和 NTFS 目录统计都有竞态。因此不再实现一次性 elevated provision，也不把 Windows Home 用户排除到一个安全性更弱的 fallback。

MicroVM 中 scratch 是固定长度 RAW block device；Guest 在其上创建 ext4，块设备写满稳定返回 `ENOSPC`。package/input 用 pure-Python ISO builder 生成 Rock Ridge media，避免 Windows `mke2fs`。QEMU 官方支持 WHPX 与 TCG；WHPX 需要启用 Windows Hypervisor Platform，TCG 则不依赖该可选功能。[QEMU WHPX](https://www.qemu.org/docs/master/system/whpx.html) [QEMU system emulation](https://www.qemu.org/docs/master/system/introduction.html) QEMU Windows chardev 原生提供双向 named pipe，可连接 Virtio serial port。[QEMU chardev](https://www.qemu.org/docs/master/system/qemu-manpage.html)

### 2.3 2026-07-16 跨架构 TCG Guest 探针

当前 Apple silicon 开发机没有 Windows host 或本机 QEMU，因此先用 Docker Desktop Linux/arm64 运行 Alpine `qemu-system-x86_64 10.1.5` 的 TCG backend，启动 Alpine `6.18.38-0-virt` x86_64 kernel 和 Go 1.26.5 静态 AMD64 `guestd`。这次探针不进入发布资产，也不改变 Windows Gate。

已证明：

- `guestd` 同一源码能逐字节确定地构建 Linux/arm64 与 Linux/amd64 initramfs；冻结的 Guest module 顺序能加载 virtio block、ext4 与 ISO9660。
- QEMU 以 `-nodefaults -nic none` 启动，四张 block media 顺序固定；rootfs/package/input 只读，scratch 为 64 MiB RAW ext4。
- Runtime 的 pure-Python ISO builder 两次生成逐字节相同的 Rock Ridge media，拒绝 input symlink、逃逸 package symlink、特殊文件和输出覆盖；Unicode 名称、空目录、权限与内部 symlink 可读回。
- 两条 Virtio serial chardev 完成 `ready → configure → configured → initialize → invoke → shutdown → stopped`；静态 Worker 以 UID/GID 65534 与 Guest cgroup v2 运行，实际读取 ISO input，拒绝 package/input 写入，并证明 scratch-backed `/tmp` 可写且 `noexec`。

未证明：Windows QEMU binary、LPAC/ACL、Job Object、Windows named pipe、WHPX、TCG 在 Windows 上的性能、固定 Guest source supply chain、Artifact/cancel/escape/ENOSPC 全套模式、最终 Electron/PyInstaller 包与崩溃恢复。因此 `windows_qemu_linux_vm_v1` 的 `proved` 仍为空，全部 Windows blocker 保留。

Windows host boundary 的候选实现位于 `apps/desktop/native/managed-worker-vm-windows.cpp`，独立 CI job 会在 `windows-latest` 用 MSVC 构建并执行 `--self-test`。这个自检不是空的启动冒烟：它创建唯一 LPAC profile，以 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 和 `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` 启动 suspended child，在恢复前加入不可 breakaway Job，并验证 LPAC token、宿主文件拒绝、零网络 capability、Job memory/CPU/process-tree limits、active-process-zero 和 profile/staging 清理。

Named Pipe 也在同一自检中按真实所有权验证：LPAC child 作为 server 创建 `\\.\pipe\LOCAL\...`，full-trust host 作为 client 交换固定 challenge。Microsoft 明确要求 AppContainer 内的 pipe 使用 `LOCAL` namespace；QEMU Windows `-chardev pipe` 正好创建单个 duplex Named Pipe server。因此只有这个自检在真实 Windows runner 通过后，才允许继续把 QEMU 接到同一边界，不能由 Linux FIFO 探针外推。[ConnectNamedPipe AppContainer constraints](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe) [QEMU pipe chardev](https://www.qemu.org/docs/master/system/invocation.html)

Apple silicon host 已用固定 digest `dockcross/windows-static-x64@sha256:e5fde458b54dda21d0265516f0310bc017532dd6f4fdad0b7239dc6ccd0f8ca9` 和 `-Wall -Wextra -Werror` 把候选源码交叉编译为 x86-64 PE32+。这个结果只证明 C++/MinGW Win32 header 与链接闭合；它不能执行 LPAC、Job、Winsock isolation 或 Named Pipe，也不计入 `proved`。MSVC 仍由独立 Windows job 负责。

### 2.4 不采用 Windows Sandbox

Windows Sandbox 使用 Hyper-V 独立内核，是执行不可信程序的强访问边界，但不适合作为 v1 Worker executor：

- 只支持 Windows Pro、Enterprise、Pro Education/SE、Education，不支持 Home；需要 BIOS virtualization、至少 4 GB RAM、两个 CPU core，并由管理员启用可选功能。[Windows Sandbox editions](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/) [Windows Sandbox install](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install)
- 默认开启网络和 clipboard，必须用自定义配置显式关闭；memory 最低会被提升到 2048 MiB，配置没有 Worker 级 CPU 或进程数硬上限。[Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)
- Windows 11 24H2 的 `wsb exec` 官方明确不支持 process I/O，无法承载 SheJane 有界 JSON-RPC；CLI 仍属于新版本/预览路径。[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) [Windows Sandbox versions](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-versions)
- 当前只能运行一个 Sandbox instance，无法提供并发 invocation。[Windows Sandbox FAQ](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-faq)

### 2.5 Hyper-V isolation：受限平台的强边界候选

Microsoft 把 Hyper-V isolated container 定义为有独立 kernel 的硬件级边界，并建议 hostile multi-tenant workload 使用它；普通 process-isolated Windows/Linux container 不被 Microsoft 视为相同强度的安全边界。[Windows container security](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/container-security) [Isolation modes](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/hyperv-container)

但它不能作为所有 Windows 用户的默认路径：

- Windows 10/11 client 需要 Pro 或 Enterprise、启用 Hyper-V 与 Containers；Home 不支持 Hyper-V role。[Install Hyper-V](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v) [Windows container setup](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/set-up-environment)
- Windows client 上的容器许可面向开发/测试；Windows Server Standard/Datacenter 的 Hyper-V container 数量许可不同。Windows base image foreign layer 的再分发受许可约束，不能直接塞进开源发行包。[Windows Containers FAQ](https://learn.microsoft.com/en-us/virtualization/windowscontainers/about/faq)
- 必须额外安装和维护 container runtime、base image、版本兼容矩阵和更新链。Windows container 的 `storage-opt size` 能限制 scratch，但只能在这套容器栈内使用。[Windows container storage limits](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/container-storage)
- 本次调研没有取得 Windows/arm64 Hyper-V isolated Windows container 的发布级一手证据；`windows/arm64` 必须独立 Gate，不能由 Windows Sandbox 的 Arm64 支持推断。

### 2.6 实验 API 不作为基线

Microsoft 2026 年公开的 `Experimental_CreateProcessInSandbox` 已能组合 AppContainer、文件只读/读写路径、网络 capability、Win32k 禁用和 Job UI restriction，很接近 SheJane 的访问层。但官方仍标注 experimental，最低 Windows 11，公开 header 不可用，而且没有 memory、CPU、process-count 或 disk limit 字段。因此只跟踪，不作为 v1 基线。[Create Process in Sandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)

### 2.7 Windows SKU 与权限矩阵

| 方案 | SKU / 最低系统 | 日常权限 | 打包与发布限制 | 决策 |
| --- | --- | --- | --- | --- |
| LPAC/Job + QEMU Linux VM | TCG 可覆盖普通 x64 Windows；WHPX 需要 Windows Hypervisor Platform | 日常 invocation 目标为普通用户；LPAC、ACL、named pipe 与 Job 仍需真机证明 | 冻结 QEMU/Guest/ISO writer，履行 GPLv2 source/SBOM；按 arch Gate | 最终候选，Gate 关闭 |
| Windows Sandbox | Windows 10/11 Pro、Enterprise、Education；无 Home | 启用 optional feature 需要管理员与可能重启 | Windows 11 24H2 新 CLI/Store 更新；无 process I/O；单实例 | 拒绝作为 Adapter |
| Hyper-V isolated container | Windows 10/11 Pro、Enterprise 或 Windows Server；硬件 virtualization | 启用 Hyper-V/Containers 和 runtime 需要管理员 | Windows client dev/test 许可；base image 再分发受限；镜像大、更新重 | 受限 SKU fallback |
| SRT/Codex dedicated user + WFP | Windows，当前上游 Alpha/实现路径 | 创建本地用户、组、持久 WFP filter 需要 elevation | 机器级状态与卸载清理；仍缺完整 Job resource limits 和 scratch quota | 参考，不作最终基线 |

## 3. Linux 决策

### 3.1 访问层：namespaces + bubblewrap + seccomp

Linux Adapter 使用一个精确版本、digest 可验证的 bubblewrap launcher：

- rootless user namespace 提供 namespace 内 capability，不授予 initial user namespace 权限；
- mount namespace 只暴露只读 system/package/input 和独立 output/tmp；根默认只读；
- PID namespace 加 fresh `/proc`，不暴露宿主 PID；IPC/UTS namespace 独立；
- network namespace 不配置 veth、bridge 或代理，默认没有宿主、loopback、LAN、DNS 和 Internet 路径；
- 关闭所有未授权 fd，固定空 HOME/PATH/env，不挂 credential、DBus socket、SSH agent 或宿主 Runtime socket；
- `PR_SET_NO_NEW_PRIVS` 后安装按架构生成的 seccomp filter；filter 继承到 fork/clone/exec descendants。

namespace 只隔离对应资源的视图，必须与 mount policy、无网络设备和 seccomp 组合使用。[Linux namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html) [User namespaces](https://man7.org/linux/man-pages/man7/user_namespaces.7.html) [Mount namespaces](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html) [Network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html) [PID namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)

seccomp 过滤 syscall 编号和参数，不理解文件路径；unprivileged process 必须先设置 `no_new_privs`。允许 fork/clone/exec 时，filter 会约束 descendants。它不能替代文件或资源隔离。[Linux seccomp filter](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html) [No new privileges](https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html)

bubblewrap 官方把自己定位为低层 sandbox 构建工具，而不是完整安全策略，因此 SheJane 仍必须拥有 mount、seccomp、cgroup、tmpfs 和黑盒 Gate。[bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)

### 3.2 资源层：delegated cgroup v2

每次 invocation 建一个 cgroup v2 leaf，在 Worker 启动前设置：

- `memory.max`：Worker 与 descendants 的硬内存上限；`memory.oom.group=1` 保证作为一个 workload 处理；
- `pids.max`：限制所有线程/进程，fork/clone 超限返回失败；
- `cpu.max`：限制 fair scheduler bandwidth；wall timeout 仍由 Runtime 单独执行；
- `cgroup.kill`：取消、超时和异常退出时对整个 subtree 发 `SIGKILL`，处理并发 fork；
- `memory.events`、`pids.events`、`cpu.stat` 与 `cgroup.events populated=0`：形成资源命中和清理证据。

这些 controller 是层级边界，delegatee 不能把进程迁出被委托 subtree，也不能放宽 parent 上限。[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html) [cgroup delegation containment](https://docs.kernel.org/admin-guide/cgroup-v2.html#delegation-containment)

为了消除“先 spawn、后移动 cgroup”之间的逃逸与计费竞态，优先要求 Linux 5.7+ 的 `clone3(CLONE_INTO_CGROUP)`，或让可信 service manager 直接在目标 cgroup 中创建 suspended launcher。[clone3 `CLONE_INTO_CGROUP`](https://man7.org/linux/man-pages/man2/clone.2.html)

普通桌面进程不能假定 `/sys/fs/cgroup` 可写。systemd 官方要求 manager 通过 unit 的 `Delegate=` 明确交出 subtree，并遵守单写者规则；缺少 delegation、controller 或纯 cgroup v2 hierarchy 时必须 fail closed。[systemd cgroup delegation](https://systemd.io/CGROUP_DELEGATION/)

### 3.3 磁盘层：有界私有 tmpfs

output 与 temp 放在 mount namespace 内的私有 tmpfs，固定 `size=` 和 `nr_inodes=`；写满必须得到 `ENOSPC`，不能继续消耗宿主其它空间。tmpfs 使用 RAM/swap，因此其容量要计入 cgroup memory 预算，Artifact 在 Runtime 校验并提升后立即卸载。[Linux tmpfs](https://docs.kernel.org/filesystems/tmpfs.html)

只设置 `memory.max` 不等价于磁盘配额；只设置 `size=` 也不能限制进程 RSS。两者都必须存在。

### 3.4 Landlock 只做纵深防御

Landlock 允许无特权进程限制自身与未来 children，能控制文件层级；新 ABI 逐步加入 TCP/UDP、Unix socket 与 signal scope。但能力随 kernel ABI 变化，旧 ABI 缺少 truncate、network、device ioctl、Unix socket 等限制；已打开的文件描述符也不受后来建立的文件规则约束。[Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html)

因此：

- mount namespace 与 fd hygiene 是主要文件边界；
- 空 network namespace 是主要网络边界；
- seccomp 是 syscall 边界；
- cgroup 是资源与进程树边界；
- Landlock 可在 ABI preflight 通过后叠加，但不能单独打开 Gate，也不能 best-effort 降级后仍报告 `sandboxed=true`。

### 3.5 本机 Docker 证据边界

2026-07-16 在当前开发机的 Docker Desktop Linux/arm64 engine `27.5.1` 上复核。默认容器仍没有 delegation：

```text
docker run --rm debian:bookworm-slim cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io memory hugetlb pids rdma

docker run --rm debian:bookworm-slim test -w /sys/fs/cgroup
exit 1
```

这证明普通容器不能作为发布证据。但 Docker Desktop 的 privileged `--cgroupns=host` 环境能为开发测试提供可写的真实 cgroup v2 hierarchy。SheJane 随后通过生产 `ManagedWorkerActionExecutor` seam 和 native Go launcher 实跑证明：

- launcher 使用 `CLONE_INTO_CGROUP` 原子把 Worker 放入 invocation leaf；
- memory/swap/OOM-group、pids 与 CPU 配置会写入并读回；
- Worker 与 descendants 合计内存超限会终止协议边界；
- Worker 忽略取消并继续 fork 时，launcher 仍用 `cgroup.kill` 清空整个 leaf，等待 `populated=0` 后删除目录；
- Go launcher 在固定 Linux/arm64 toolchain 中双构建逐字节一致。

随后加入的完整 Linux/arm64 候选继续在同一真实 kernel Gate 上证明：冻结 Bubblewrap 0.11.2 建立只读 root/package/input 和独立 mount/PID/network/IPC/UTS namespace；host-owned seccomp 禁止 socket、mount、namespace、ptrace、跨进程读取、BPF、keyring、io_uring 以及嵌套 user namespace；私有 tmpfs 固定 bytes/inodes 并在写满时返回 `ENOSPC`。Worker 只看见私有 `/output`，broker 在 Worker 启动前卸载临时 host-output mount、保护描述符并只复制协议中声明且通过 `openat`/`O_NOFOLLOW` 校验的普通 Artifact，未声明 filler 不会进入宿主目录。

Bubblewrap 源码、大小、SHA-256、无 setuid 构建选项、固定 Debian builder、`libcap`、许可证和输出 manifest 已冻结；两次构建逐字节一致。生产 `ManagedWorkerActionExecutor` Gate 已通过宿主文件、credential、PID identity、Unix socket、loopback、外网、只读路径、broker fd/mount、seccomp、scratch、OOM、取消和清理。privileged Docker hierarchy 仍不是最终 Desktop delegation，因此当前只把这些写入 `proved`；`systemd_delegation_gate` 与 `release_ci_gate` 继续阻止 `linux/arm64` 启用。

### 3.6 Linux 打包限制

- `linux/x86_64` 与 `linux/arm64` 分别冻结 launcher、bubblewrap、Worker、Runtime Asset 和 seccomp arch；一个架构通过不能外推另一架构。
- 系统 bubblewrap 只有在版本和路径满足策略时才能使用；否则使用随包冻结且 digest/签名匹配的 helper。不能从工作区或 `$PATH` 任意取二进制。
- user namespace、seccomp、cgroup v2 delegation、memory/pids/cpu controller、tmpfs mount 任一缺失即 `executor_unavailable`；不回退到普通子进程、Docker socket、sudo 或宿主 shell。
- Flatpak、Snap、AppImage、发行版安全策略和容器宿主可能限制嵌套 namespace 或 delegation；每种最终分发物必须跑 packaged Gate，source-tree test 不够。

## 4. SheJane Release Gate

`sandboxed` 只由 Runtime 根据当前 OS、arch、adapter version 和 policy digest 计算：

```text
sandboxed = process_isolated && access_isolated && resource_isolated
```

Worker handshake、manifest、签名、publisher、用户确认和环境变量都不能修改此结果。

### 4.1 能力映射

| Gate | Windows LPAC + Job 候选 | Linux bwrap + cgroup v2 候选 | 必须取得的发布证据 |
| --- | --- | --- | --- |
| 文件 | AppContainer/LPAC + 精确 ACL | read-only mount namespace + 可选 Landlock | Worker/child/grandchild 不能读 home、credential 或相邻文件；package/input 不可写；symlink/hardlink/rename/special-file 逃逸失败 |
| 网络 | 无 network capability；仍测 loopback/named pipe/COM | 空 network namespace + seccomp | IPv4/IPv6 loopback、LAN、Internet、DNS/UDP、metadata、Unix socket/named pipe 全部失败 |
| 进程树 | suspended start 后进入不可 breakaway Job | PID namespace + 启动即进入 delegated cgroup | child/grandchild 无法逃出，不能检查宿主进程、继承 handle/fd 或借 broker 生成外部进程 |
| 内存 | `JOB_OBJECT_LIMIT_JOB_MEMORY` | `memory.max` + `memory.oom.group` | descendants 合计超限，Worker 边界终止且 Runtime 存活；读取 Job/cgroup limit event |
| CPU | Job CPU hard cap + wall timeout | `cpu.max` + wall timeout | 无限循环受内核限制，timeout 后整个树退出，记录 accounting |
| 进程数 | `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | `pids.max` | fork/spawn bomb 达到上限后失败，边界外无 surrogate |
| 磁盘 | **未解决：固定 scratch volume** | `tmpfs size,nr_inodes` | 写满返回 `ENOSPC`/等价错误，不能消耗配额外宿主空间 |
| 输出 | Runtime frame/stdout/stderr/Artifact cap | 同左 | 超 frame、流或 Artifact 上限 fail closed，不提交部分产物 |
| 取消 | `TerminateJobObject`/kill-on-close | cooperative cancel 后 `cgroup.kill` | 正常、取消、超时、Worker crash、Runtime crash 后全部 descendants 归零 |
| 清理 | completion port + Job query + profile/ACL/scratch recovery | `cgroup.events populated=0` + unmount + lease recovery | 无 process、Job/cgroup、mount、pipe/socket、profile、ACL 或 scratch 残留 |

### 4.2 Preflight

Windows 必须检查：

- OS build、arch、LPAC/AppContainer API 与 profile create/delete；
- launcher/helper/Worker 的签名与 digest；
- AppContainer 默认无网络，package/input/output ACL 精确生效；
- Job memory/CPU/process/kill/completion-port 全部可设置并读回；
- 固定 scratch provision、attach、detach 和 crash recovery 已在当前 SKU 通过。

Linux 必须检查：

- kernel、arch、user/mount/PID/network namespace；
- `no_new_privs`、seccomp 和当前 arch filter；
- cgroup v2 delegated subtree 及 `memory`、`pids`、`cpu` controller；
- `CLONE_INTO_CGROUP` 或等价无竞态启动；
- 私有 tmpfs 能以固定 bytes/inodes 挂载；
- launcher/bubblewrap/Worker/Runtime Asset digest 精确匹配。

任何 preflight 失败都返回 `executor_unavailable`；不允许 warning-dialog override。

### 4.3 发布矩阵

| Target | 当前判断 | 打开 Gate 前的最后条件 |
| --- | --- | --- |
| `windows/x86_64` | QEMU Linux VM 方向成立，未验证 | TCG packaged Gate；LPAC VMM/Job；无网络 Guest；只读 ISO；固定 RAW scratch；Guest cgroup/Artifact/crash/cancel/escape cleanup |
| `windows/arm64` | QEMU WHPX 有上游支持，无本项目证据 | 原生 arm64 QEMU/launcher/kernel/Guest/Worker/Asset；与 x64 相同的完整 Gate |
| `linux/x86_64` | helper 可交叉编译并通过 vet，未做原生执行 | 原生 x86_64 最终包完成 namespace/seccomp/cgroup/tmpfs/broker/descendant/systemd Gate |
| `linux/arm64` | Docker Desktop 真实 kernel 已通过完整 bwrap/seccomp/cgroup/tmpfs/broker/逃逸/清理候选 Gate；P6 已接包内 manifest 与 systemd delegation preflight | 最终 PyInstaller Runtime 在真实 `Delegate=yes` + `DelegateSubgroup=` service 中跑通已配置 release Gate |

## 5. Adapter 实现边界

当前实现只记录真实 kernel 已证明的能力，不为了统一表面伪造跨平台 Adapter：

- Windows 需要真实 SKU/arch runner，才能验证 LPAC VMM、Job 全限制、QEMU TCG/WHPX、Virtio serial named pipe 和 packaged cleanup；macOS 上只实现并验证跨平台 ISO/ABI 契约，不伪造 Win32 证据。
- Linux/arm64 native launcher 已组合并实跑 Bubblewrap namespace、seccomp、原子 cgroup、定容 tmpfs 与可信 Artifact broker；P6 只从哈希绑定的包内 manifest 加载，并要求 systemd `user.delegate=1` 父级与独立 supervisor subgroup。
- Linux 尚缺最终 PyInstaller 产物上的真实 systemd release job；amd64 尚缺全部原生执行。因此 release matrix 仍 fail closed，不能从 arm64 Docker 证据外推。
- 复制 Codex/SRT launcher 仍不足以形成相同资源和 Artifact 边界；旧 SRT 路径不会设置 `resource_isolated=true`。

下一步按平台分别继续，不改变统一的 `ActionExecutor` 契约：

1. Windows runner：冻结 QEMU TCG 启动 x86_64 Linux Guest，完成 LPAC VMM + suspended Job + read-only ISO + fixed RAW scratch + Virtio serial + descendant/cancel/escape packaged Gate；WHPX 在支持 nested virtualization 的独立 runner 补性能路径。
2. Linux runner：运行已配置的最终 PyInstaller + systemd transient-service Gate；成功后只移除该架构实际通过的 blocker。

只有对应 OS、arch、最终打包形态的三层 Gate 全部通过，Registry 才允许非受信任 Managed Worker。当前 Linux/arm64 候选在直接 Executor Gate 中会报告完整 isolation，但生产 Registry 仍因 systemd/release blocker 拒绝创建它；不存在部分证据提前开放。
