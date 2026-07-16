# Managed Worker：Agent 沙箱现状与三平台硬隔离方案

> 调研日期：2026-07-16
>
> 资料范围：OpenAI Codex、Pi、Anthropic Sandbox Runtime、LangGraph / Deep Agents 的官方文档与源码，以及 Apple、Microsoft、Linux Kernel 官方文档。
>
> 结论适用范围：执行任意来源、未经信任的 `managed_worker`。包签名、发布来源和用户确认都不替代运行时隔离。

## 结论

**目前没有一个现成 Agent 库或本地跨平台 launcher，能在 macOS、Linux、Windows 同时证明文件、网络、进程、CPU、内存、进程数和磁盘的硬隔离。**

- Codex、Pi 的 Sandbox 示例和 Anthropic Sandbox Runtime（SRT）主要解决访问权限；没有完整的跨平台 Worker 资源配额。
- Deep Agents 把强隔离交给 Daytona、Modal、Runloop、AgentCore、LangSmith 等外部 sandbox provider，不是本地三平台实现。
- Linux 可以用 namespaces / bubblewrap + seccomp + cgroup v2 + 有大小上限的私有 tmpfs 完成本地原生硬隔离，但必须先证明 cgroup controller 已委托给当前 Runtime。
- Windows 的 AppContainer/LPAC + Job Object 可以保护宿主 VMM 并限制其资源，但不能在普通用户权限下给 Worker 提供固定容量目录。Windows 因此改用 LPAC/Job 包裹的 QEMU Linux MicroVM，由 Guest 固定容量块设备提供完整磁盘边界。
- macOS App Sandbox / Seatbelt 能限制访问，但 Apple 没有公开一个与 cgroup v2 或 Windows Job Object 等价的、可对任意子进程树同时设置内存和进程数硬上限的 API。

因此，SheJane 的最优默认路径是：

1. **Linux：本地原生 adapter。** SRT/bubblewrap 负责访问层，cgroup v2 和私有 tmpfs 负责资源层。
2. **Windows：本地 Linux VM adapter。** QEMU 使用 WHPX 加速或 TCG 兼容执行；VMM 自身置于无 capability 的 LPAC 和不可 breakaway Job 中。Guest 不配置网络设备，package/input 使用只读 ISO，scratch 使用固定大小 RAW ext4 块设备。
3. **macOS：本地轻量 Linux VM adapter。** 使用 Apple Virtualization.framework；不给 VM 网络设备，只挂载只读系统/输入盘和固定大小输出盘，通过 Virtio socket 传协议。
4. **不把 trusted-native 当成沙箱。** 如果以后产品允许用户明确完全信任某个原生插件，它仍然必须显示 `sandboxed=false`，也不能满足非受信任 Managed Worker Gate。
5. **远程 sandbox 只作为可选企业 executor。** 它不应成为开源、本地优先产品的默认依赖。

这不是要求三个平台内部使用同一个 OS primitive。统一的是 SheJane 的 Action 协议、Artifact、receipt、limits 和 Gate；不同平台使用能真正成立的边界。

## Runtime 阶段

```text
主要阶段：P6，绑定资源并取得 Agent 定义
上游输入：P5 冻结的插件版本、digest、输入引用、能力与 limits
下游输出：P7/P10 可执行的固定 Action 目录和平台 SandboxLease
状态所有者：Runtime PluginRegistry、ManagedWorkerAdapter、P10 tool receipt、P11 cleanup
替换的当前路径：普通子进程只提供故障边界、Managed Worker Registry 保持 fail closed
```

Action 在 P10 执行；P11 必须证明进程树/VM、管道、cgroup/Job、scratch 和租约已经清理；P12 只提交 Runtime 重新校验后的结果与 Artifact。

## 1. 现有 Agent 实际做了什么

### 1.1 OpenAI Codex

Codex 当前按平台实现本地命令访问隔离：

- macOS 使用 Seatbelt / `sandbox-exec`，根据策略生成读写和网络规则。[Codex Seatbelt launcher](https://github.com/openai/codex/blob/08924bca0058eeaf179d2291af2c485123dbf2a2/codex-rs/core/src/seatbelt.rs)
- Linux 当前默认使用 bubblewrap，只读根文件系统，按路径重挂可写目录，并启用 user/PID/network namespace、`no_new_privs` 和 seccomp 网络策略。[Codex Linux sandbox README](https://github.com/openai/codex/blob/08924bca0058eeaf179d2291af2c485123dbf2a2/codex-rs/linux-sandbox/README.md)
- Windows 使用 restricted-token/elevated runner 路径和 Job Object；当前 Job Object 代码设置的是 `KILL_ON_JOB_CLOSE`，不是 Worker 内存、CPU 或进程数配额。[Codex Windows command runner](https://github.com/openai/codex/blob/08924bca0058eeaf179d2291af2c485123dbf2a2/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs)
- Codex 的通用 process hardening 在 Unix 上设置 `RLIMIT_CORE=0`，用于禁止 core dump；它不是 Worker 资源 sandbox。[Codex process hardening](https://github.com/openai/codex/blob/08924bca0058eeaf179d2291af2c485123dbf2a2/codex-rs/process-hardening/src/lib.rs)

判断：Codex 是很好的文件、网络和进程清理参考，但不能直接把它的 `sandbox` 状态解释为 SheJane 的 `resource_isolated=true`。

### 1.2 Pi

Pi 的 extension 在宿主进程中加载，官方文档明确说明 extension 拥有用户的完整系统权限。[Pi extension security](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/docs/extensions.md#extension-locations)

Pi 提供的 sandbox 是一个示例 extension：它只替换 bash tool，并把命令交给 `@anthropic-ai/sandbox-runtime`。这证明“保留 Agent 工具协议、把 OS policy 交给 launcher”是可行组合；它没有隔离所有 Pi extensions，也没有添加硬资源配额。[Pi sandbox extension](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/examples/extensions/sandbox/index.ts)

该示例当前固定 SRT `0.0.26`，不能用它推断 SRT `0.0.65` 的 Windows 或安全行为。[Pi sandbox package](https://github.com/badlogic/pi-mono/blob/c6d8371521fc8357958bb21fd43552c15f46c7f4/packages/coding-agent/examples/extensions/sandbox/package.json)

### 1.3 Anthropic Sandbox Runtime

SRT `0.0.65` 是当前最完整的跨平台访问隔离候选，但项目仍标记为 Beta Research Preview。[SRT README](https://github.com/anthropic-experimental/sandbox-runtime/tree/cf24a43eba92c9ab4140c380d11ca55771be9db2) [SRT package version](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/package.json)

- macOS：`sandbox-exec` / Seatbelt，控制文件、网络、Unix socket、Apple Events。
- Linux：bubblewrap + network namespace + seccomp，控制挂载视图、网络和部分 IPC。
- Windows（Alpha）：专用本地用户、WFP egress fence、NTFS ACL、restricted token 和 Job Object。

SRT 声明规则覆盖整个进程树，但公开配置 schema 没有 CPU、内存、进程数或磁盘容量字段。[SRT configuration schema](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/src/sandbox/sandbox-config.ts)

Windows 的 Job Object 只设置 kill-on-close 和 UI restrictions，没有 Job memory、CPU rate 或 active process limit。[SRT Windows Job source](https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/vendor/srt-win-src/src/job.rs)

判断：SRT 可以继续作为访问层依赖，但 `SandboxManager.initialize()` 成功不能使 SheJane 报告 `resource_isolated=true`。

### 1.4 LangGraph / Deep Agents

LangGraph 负责图执行、状态和恢复；本地代码隔离不是它的 Runtime primitive。Deep Agents 的 `BaseSandbox` 以 provider 的 `execute()` 为最小接口，其它文件操作建立在 shell command 上。[Deep Agents sandbox architecture](https://docs.langchain.com/oss/python/deepagents/sandboxes#the-execute-method)

官方生产方案主要是远程或托管 provider，例如 Daytona、Modal、Runloop、AgentCore 和 LangSmith。官方也明确区分“Agent 在 sandbox 内”和“sandbox 作为外部 tool”，并提醒网络外泄和 secret 风险。[Deep Agents sandboxes](https://docs.langchain.com/oss/python/deepagents/sandboxes)

判断：Deep Agents 证明 provider boundary 合理，但不提供 SheJane 可以直接打包的本地三平台 hard sandbox。

## 2. 逐平台方案

### 2.1 Linux：本地原生，可行但必须条件化

访问层：

- rootless user namespace；PID、mount、network、IPC/UTS namespace；
- bubblewrap 构建最小只读文件系统视图；package、Runtime Asset、input 只读，output 独立可写；
- `no_new_privs` + seccomp；默认没有网络 namespace；关闭 Unix socket、ptrace、mount、keyring 等不需要的 syscall；
- 不继承宿主 fd、环境、credential、HOME 和用户 PATH。

资源层：

- 每次 invocation 建一个 cgroup v2 leaf；先写 `memory.max`、`pids.max`、`cpu.max`，再把 suspended launcher 放入 cgroup 后恢复；
- wall timeout 后写 `cgroup.kill`；等待 `cgroup.events: populated 0`；
- output/temp 使用带 `size=` 的私有 tmpfs，且只能在 mount namespace 内看到；
- stdout/stderr 仍由 Runtime byte cap 控制。

Linux 内核文档明确说明 cgroup v2 的 controller 是层级强制边界，限制不能被下层放宽；`memory.max`、`pids.max`、`cpu.max` 和 `cgroup.kill` 可以覆盖整个子树。[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

bubblewrap 官方明确把自己定位成低层 sandbox 构建工具，而不是完整安全 policy，因此 SheJane 仍必须拥有 seccomp、cgroup、mount 和 Gate。[bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)

发布条件：如果当前 Runtime 没有委托的 cgroup v2 subtree、controller 缺失、user namespace 被禁用，或 seccomp arch 不支持，adapter 必须 fail closed；不回退到普通子进程。

### 2.2 Windows：LPAC 包裹的本地 Linux MicroVM

原生 Worker 路线已经停止：Job Object 不限制目录大小，而固定 VHDX 的 attach 需要宿主存储权限，普通 Electron 进程不能可靠取得。轮询剩余空间存在竞态，不能满足 `resource_isolated=true`。[AttachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk)

Windows adapter 改为与 macOS 相同的 Linux Guest ABI：

- Host 以无 network、registry、COM、device 或 credential capability 的 LPAC 启动 QEMU，并在恢复前放入不可 breakaway Job；Job 强制 kill-on-close、memory、CPU 与 active-process limits。
- QEMU 不创建 network device，只挂载冻结只读 rootfs、只读 Rock Ridge package/input ISO，以及一个文件长度等于 `scratch_bytes` 的 RAW block device。
- Guest 在 RAW device 内创建并挂载 ext4，因此写满由块设备容量稳定返回 `ENOSPC`；Worker 仍以非特权 UID 和 cgroup v2 leaf 执行。
- Host/Guest 通过两个 Virtio serial port 连接 Windows named pipe，继续承载有界 control 与 Artifact 通道，不启用共享目录、SMB、9p、VirtioFS 或宿主网络。
- `host_platform=windows/<arch>`，`execution_platform=linux/<arch>`；同架构 Linux Worker 与 Runtime Asset 可被 Linux、macOS VM 和 Windows VM 复用。

QEMU 官方支持 Windows Hypervisor Platform（WHPX）和跨平台 TCG。WHPX 需要启用 Windows Hypervisor Platform；未启用时使用 TCG 只影响性能，不降低隔离契约。[QEMU WHPX](https://www.qemu.org/docs/master/system/whpx.html) [QEMU accelerators](https://www.qemu.org/docs/master/system/introduction.html) Windows named-pipe chardev 是单一双向 `\\.\pipe\...`，可连接 Virtio serial port。[QEMU chardev](https://www.qemu.org/docs/master/system/qemu-manpage.html)

package/input 不再要求 Windows 版 `mke2fs`。Runtime 用固定版本 pure-Python ISO writer 生成带 Rock Ridge 权限的只读 ISO；scratch 只由冻结 Guest 工具创建 ext4。QEMU 是 GPLv2，最终包必须同时冻结 source、binary digest、许可证、对应源代码提供方式与 SBOM。[QEMU license](https://www.qemu.org/docs/master/about/license.html)

### 2.3 macOS：原生进程不满足，默认使用本地 VM

Apple App Sandbox 能限制文件、网络和系统资源；直接 fork/exec 的 helper 继承宿主 sandbox，拥有不同能力则需要 XPC/helper 设计。[Apple App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox) [sandboxed helper](https://developer.apple.com/documentation/Xcode/embedding-a-helper-tool-in-a-sandboxed-app)

这条路径还要求 helper 的 App Sandbox / inherit entitlements、代码签名和发布链正确。更重要的是，Apple 的公开 App Sandbox 文档没有给出每个任意 Worker process tree 的 hard memory、process-count 和 disk quota。因此：

- Seatbelt/SRT 能证明 `access_isolated=true`；
- parent RSS polling、`RLIMIT_RSS`、定时 kill、nice/priority 不能证明 `resource_isolated=true`；
- native helper/XPC 仍不能打开非受信任 Managed Worker Gate。

默认 macOS adapter 使用 Apple Virtualization.framework 启动短命 Linux VM：

- `host_platform` 仍是 `darwin/<arch>`，但 `execution_platform` 是 `linux/<arch>`；manifest、Worker 和 Runtime Asset 必须匹配 guest ABI。现有 Darwin 原生参考包不能放进 VM 执行，必须重建对应 Linux 资产；同一 Linux 包可供同架构 Linux host 与 macOS VM 复用。

- `VZVirtualMachineConfiguration.memorySize` 固定 VM 可见内存，`CPUCount` 固定 vCPU 数；
- 不配置 network device，因此 guest 没有 IP 网络接口；
- 只读 root disk 固定 digest；input 生成一次性只读 disk；output/temp 使用固定最大容量 scratch disk；
- Host 与 guest 只通过一个 Virtio socket 传有界 Worker JSON-RPC，不共享宿主目录、不传宿主 fd；
- guest 内设置 `pids.max` 和 CPU policy；wall timeout 由 Host 停止整个 VM；
- VM 停止后 Host 从 scratch image 重算 Artifact digest，验证完成后删除磁盘与租约。

Apple 官方 Virtualization.framework 支持 Linux VM，并明确配置 CPU、memory、network、storage 和 socket device；使用它需要 `com.apple.security.virtualization` entitlement。[VZVirtualMachineConfiguration](https://developer.apple.com/documentation/virtualization/vzvirtualmachineconfiguration) [Linux VM](https://developer.apple.com/documentation/virtualization/creating-and-running-a-linux-virtual-machine) [Virtio socket](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdeviceconfiguration) [storage attachment](https://developer.apple.com/documentation/virtualization/vzstoragedeviceattachment) [virtualization entitlement](https://developer.apple.com/documentation/bundleresources/entitlements)

这是最优安全边界，不是最短实现。代价是需要为 Intel/Apple silicon 分别打包或下载签名的 kernel/rootfs、启动延迟更高、发布测试更重。v1 保持每次 invocation 一台短命 VM；只有数据证明启动成本不可接受后，才设计只读 snapshot/pool，且 pool 不能跨插件版本或用户复用可写状态。

#### 2026-07-16 macOS 启动能力验证

在 Apple M4 Pro、macOS 26.5.1 上完成了一次不进入产品包的启动探针：

- 使用 Apple 官方 Linux VM 样例的 `VZLinuxBootLoader`、2 vCPU、2 GiB memory、Virtio console 配置和 `com.apple.security.virtualization` entitlement；没有配置 network device。
- Fedora 44 `aarch64` 的 `vmlinuz` 与 `initrd.img` 分别通过官方 `.treeinfo` 中的 SHA-256 `e55a5f9...474da`、`19bf3a8...5eff` 校验。
- Fedora `vmlinuz` 是 zstd EFI zboot wrapper，不能直接交给 `VZLinuxBootLoader`。按 Linux kernel `zboot-header.S` 的 payload offset/size 解压为 ARM64 `Image` 后，VM 成功启动，串口进入 Fedora 44 initramfs emergency shell。
- 临时 Fedora 资产、Swift 探针和 ad-hoc 签名二进制不进入仓库，也不作为生产供应链。

这只证明当前 macOS/硬件/SDK 能启动无网络设备的 ARM64 Linux guest。它没有证明冻结 guest、Virtio socket、磁盘配额、guest 内 cgroup、逃逸阻断或清理，因此该次验证只增加 `virtualization_framework_boot`，release gate 仍保持关闭。[Apple Linux VM sample](https://developer.apple.com/documentation/virtualization/running-linux-in-a-virtual-machine) [Linux ARM64 boot requirements](https://docs.kernel.org/arch/arm64/booting.html) [Linux zboot build contract](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/drivers/firmware/efi/libstub/Makefile.zboot)

同日又完成了仓库自有最小 guest 验证：Go 1.26.5 以 `CGO_ENABLED=0` 交叉编译静态 Linux/arm64 `guestd`，Runtime 构建器用固定 metadata 生成 1.5 MiB `newc` initramfs；两次构建逐字节一致，当前摘要为 `sha256:477a39fb...351b`。该 initramfs 在 1 vCPU、256 MiB、无 network device 的 VM 中作为 `/init` 启动并输出 `shejane-guestd: booted`。这新增 `deterministic_minimal_guest_boot` 证据，但 production kernel、guest-host protocol、固定磁盘、资源控制与清理 Gate 仍未完成。

随后验证了最小 Host↔Guest 控制通道。Fedora 44 kernel 将 VSOCK 编译为模块，因此构建器只接受与该 kernel 配对的三个 ARM64 可重定位 ELF：`vsock.ko`、`vmw_vsock_virtio_transport_common.ko`、`vmw_vsock_virtio_transport.ko`；它们来自官方 `kernel-modules-core-6.19.10-300.fc44.aarch64` 包（SHA-256 `92fff7c5...b677`）。`guestd` 仅在 `AF_VSOCK` 返回 `EAFNOSUPPORT` 时依次加载这三个模块，不携带 shell、`modprobe` 或完整 Fedora userspace。

加入模块后的确定性 initramfs 为 1.7 MiB，探针摘要 `sha256:e6aa3128...efc9`。它在 1 vCPU、256 MiB、无 network device 的真实 VM 中完成有界 `ready → shutdown → stopped` 帧交换并由 guest 主动关机，因此 release gate 新增 `virtio_socket_handshake` 和 `cooperative_guest_shutdown`。后续真实门禁覆盖 `succeeded`、`failed`、hostile Artifact、忽略取消和非法 JSON，`guest_host_protocol` 已从 blocker 移到 proved。[Virtio socket connection](https://developer.apple.com/documentation/virtualization/vzvirtiosocketconnection) [Linux VSOCK configuration](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/net/vmw_vsock/Kconfig)

#### 2026-07-16 macOS 固定磁盘能力验证

Codex/Pi 的本机 sandbox 不提供 VM 文件镜像层；Deep Agents 把文件系统和执行隔离交给 Daytona、Modal、Runloop 等外部 provider。与 SheJane 本地离线目标更接近的是 Firecracker：Host 先生成 Guest kernel 支持的文件系统镜像，再把文件支持的 block device 分别配置为只读或读写。macOS adapter 因而采用 ext4 RAW image，而不使用 VirtioFS 共享宿主目录。[Deep Agents sandbox providers](https://github.com/langchain-ai/deepagents/blob/main/deepagents-deploy.md#sandbox-providers) [Firecracker storage design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md#storage) [Firecracker rootfs build](https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md#creating-a-linux-rootfs-image)

Runtime 新增 Host-owned ext4 image builder：只接受绝对路径、非 symlink、SHA-256 精确匹配且版本为 `mke2fs 1.47.2` 的 helper；不搜索 `$PATH`。输入树拒绝 symlink 和特殊文件，按字节序遍历，并把文件/目录归一化为只读权限与 epoch mtime；固定 UUID、feature set、hash seed 和禁用 lazy initialization 后原子生成固定容量镜像。当前本机 Android e2fsprogs helper 仅用于能力探针，生产仍必须随 launcher 冻结、签名并记录 helper digest。两次 16 MiB input image 构建逐字节相同，摘要均为 `sha256:e9d4b0bf...04e5f`。[mke2fs options](https://man7.org/linux/man-pages/man8/mke2fs.8.html) [e2fsprogs reproducible-build support](https://e2fsprogs.sourceforge.net/e2fsprogs-release.html)

真实 VM 随后挂载两个 `VZDiskImageStorageDeviceAttachment`：input attachment 设置 `readOnly=true`，scratch 设置 `readOnly=false`，两者均为 16 MiB RAW ext4。Guest kernel 识别 `/dev/vda`、`/dev/vdb`；`guestd` 挂载 `devtmpfs` 后将 input 以 `ro,nodev,nosuid,noexec` 挂载，写探针得到 `EROFS`，将 scratch 以 `rw,nodev,nosuid,noexec` 挂载并成功写删探针，再以 `BLKGETSIZE64` 向 Host 报告精确 16 MiB 容量。VSOCK 完成 shutdown 后两个文件系统均正常卸载，VM 主动关机。这新增 `deterministic_ext4_disk_images`、`read_only_input_mount`、`fixed_capacity_scratch_mount` 证据。[Apple read-only disk attachment](https://developer.apple.com/documentation/virtualization/vzdiskimagestoragedeviceattachment/isreadonly) [Apple RAW disk attachment](https://developer.apple.com/documentation/virtualization/vzdiskimagestoragedeviceattachment/init%28url%3Areadonly%3A%29-9qeco)

真实 VM 随后由非特权 Worker 证明无法 remount input、scratch 写满稳定返回 `ENOSPC`、超过 `output_mb` 的 Artifact 在 Guest 端 fail closed，并在成功、失败和取消后删除 image staging；`input_output_disk_limits` 已从 blocker 移到 proved。

同日新增单文件 Swift launcher `managed-worker-vm.swift`，直接使用 Foundation、Darwin 和 Virtualization.framework，不引入 SwiftPM 或第三方依赖。它只接受绝对普通文件和有界整数参数，固定 1 vCPU、无 network/serial device、input attachment 只读，验证 Guest 磁盘证明后才把有界 newline frame 在 stdio 与 VSOCK 之间转发；wall timeout、SIGINT/SIGTERM 会停止整台 VM。构建脚本以专属 `com.apple.security.virtualization` entitlement 签名并运行内置 frame self-test。

真实 `electron-builder --dir` 检查发现默认签名会遍历 `Contents` 中的每个路径；因此完整 VM 资产集先签名可执行文件、生成 manifest 并设为只读，macOS 配置再用 `signIgnore` 跳过整个 `sandbox/vm-assets`，最后由外层 App 签名封存。最终 `.app` 内 launcher 保留 Virtualization entitlement，整套资产与构建输出逐字节一致，App `codesign --verify --deep --strict` 通过；release workflow 也执行相同检查。生产 Executor 已从包内 manifest 完成 13-mode VM 往返，包括 Worker/descendant 宿主逃逸、Worker/launcher crash cleanup 和 Runtime `SIGKILL` 后的 crash-safe lease recovery，因此 release gate 新增 `packaged_vm_asset_set`、`host_file_credential_network_ipc_isolation`、`worker_crash_vm_cleanup`、`launcher_crash_cleanup`、`runtime_crash_lease_recovery`，并移除旧 `packaged_launcher` 与 `sandbox_escape_and_cleanup_gate` blocker。[electron-builder extra binaries](https://www.electron.build/mac/#signing-additional-binaries) [electron-builder extra resources](https://www.electron.build/docs/contents/#extraresources)

同一真实 VM 随后完成 `ready → configure → configured → shutdown → stopped`。`guestd` 直接挂载 cgroup v2，要求 `cpu`、`memory`、`pids` 三个 controller，建立 worker leaf 并写入、回读 `memory.max=64 MiB`、`memory.swap.max=0`、`memory.oom.group=1`、`pids.max=16`、`cpu.max=100000 100000`；Swift launcher 只有在 Guest 精确回报同一策略后才向 Runtime 发出 ready。VM 仍为 1 vCPU、256 MiB、无网络设备，最终协作卸载并以状态 0 退出。这新增 `guest_cgroup_v2_resource_policy` 证据。[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

真实 VM 随后执行 descendant 资源攻击：16 MiB cgroup 触发 `memory.oom.group`，Guest 从 `memory.events` 识别 `oom_kill` 并向 Runtime 返回 `resource_exhausted`；`pids.max=16` 让第 16 个 descendant 创建失败，shutdown 后仍由 `cgroup.kill` 清到 `populated 0`。CPU 由 1 vCPU VM 和 `cpu.max=100000 100000` 双重封顶，无需人为把正常插件降到 50%。`hard_cpu_memory_process_tree_limits` 已从 blocker 移到 proved；宿主访问逃逸仍由独立 Gate 覆盖。

为解决 host/guest ABI 边界，Registry、Catalog 与 Runtime Asset Store 在 macOS 宿主上现统一选择 `linux/<arch>`；release gate 仍按 `darwin/<arch>` 宿主 backend 判定，避免误套 Linux host Gate。Guest 新增第三块 `SHEJANE_PACKAGE` ext4：Host builder 只保留已安装包的 executable bit，重新验证内部相对 symlink 并拒绝越界；launcher 将它作为只读 block device，Guest 以 `ro,nodev,nosuid` 挂载到 `/package`。用户附件仍在独立的 `ro,nodev,nosuid,noexec` `/input`，因此不会因 Worker 需要执行代码而获得执行权限。真实 VM 已完成 package 写入 `EROFS`、input 写入 `EROFS`、scratch 读写、cgroup attestation 和协作关机，release gate 新增 `read_only_package_mount`。完整 Worker/Runtime Asset staging、非特权 exec 和 Artifact Gate 尚未完成。

随后加入静态 Linux/arm64 黑盒 Worker。`guestd` 使用 Go 标准库的 `UseCgroupFD` 在创建进程时原子加入 worker cgroup，并固定 UID/GID 65534、空 PATH、新进程组与 parent-death `SIGKILL`；Worker 无法修改 cgroup、package 或 input，只能写 scratch。真实 VM 完成 `initialize → invoke → shutdown`，读取授权 input、写入并声明 Artifact，再由 Guest 执行 `cgroup.kill`、等待 `populated 0`、删除 leaf、发送 `stopped` 和关机。同一流程已固化为环境驱动的 `test_macos_managed_worker_vm_gate.py`，并改为直接调用生产 `ManagedWorkerActionExecutor`；成功、失败、hostile symlink、取消、malformed-frame、descendant OOM 和 PID exhaustion 路径均本机实跑通过，release gate 新增 `nonprivileged_guest_worker_action_protocol`、`runtime_adapter_vm_roundtrip`、`guest_host_protocol`。生产 Runtime factory 和资产 manifest preflight 已接线；冻结打包资产以及宿主逃逸仍由原 blocker 覆盖。

Host 没有固定的 `debugfs/e2cp/fuse2fs`，也不应在宿主直接解析不受信任的 ext4。参考 Firecracker agent `CopyFile` 与 Kata VSOCK agent，Guest 与 Swift launcher 新增独立 Artifact VSOCK：`guestd` 在放行 invoke response 前，以安全 `openat/O_NOFOLLOW` 链读取 Worker 声明的 regular file，发送相对 path、size、SHA-256 与原始 bytes；launcher 在私有 output root 中用 `openat/O_NOFOLLOW/O_EXCL` 创建文件，执行总量与 digest 校验后 ACK。真实 Gate 已证明 Host 得到精确 Artifact；hostile symlink 和超限 Artifact 会使 VM fail closed 且 Host 不落文件。release gate 新增 `vsock_artifact_extraction`；多 Artifact/大文件与最终 Runtime Artifact 提升仍由后续平台/产品 Gate 覆盖。[Firecracker containerd agent design](https://github.com/firecracker-microvm/firecracker-containerd/blob/main/docs/design-approaches.md) [Kata agent architecture](https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/README.md)

Guest 控制代理随后加入 Host-owned 取消语义：版本化 `cancel` 帧先转发给 Worker，50 ms 后仍未退出就写入 worker leaf 的 `cgroup.kill`，并且只有 `cgroup.events` 达到 `populated 0`、leaf 删除和 `stopped` 发出后才允许 launcher 成功退出。真实 VM Gate 使用故意忽略取消的 Worker，证明 Runtime 生产取消路径可在一秒 grace 内完成，release gate 新增 `guest_cancel_process_tree_cleanup`；这不替代打包 CI、异常终态或资源耗尽攻击测试。

## 3. 可验证 Release Gate

`sandboxed=true` 只能由 Runtime 根据当前平台 release matrix 计算：

```text
sandboxed = process_isolated && access_isolated && resource_isolated
```

Worker、自述 manifest、环境变量、包签名或 UI 确认都不能修改这个结果。

### 3.1 Preflight Gate

每次启动 Runtime 和每次升级 adapter 后验证：

- OS、arch、最低版本、内核/Windows build/macOS entitlement；
- launcher/helper/VM rootfs 的精确 digest 和签名；
- Linux user namespace、seccomp、cgroup v2 delegation、memory/pids/cpu controller；
- Windows AppContainer/LPAC、Job Object、scratch volume provision；
- macOS Virtualization entitlement、VM configuration validation、对应架构 guest image；
- 任一检查失败即 `executor_unavailable`，不回退。

### 3.2 黑盒逃逸 Gate

以下探针必须分别由 Worker、child 和 grandchild 执行，并在打包后的真实应用中运行：

| 类别 | 必须失败/受限的行为 |
| --- | --- |
| 文件 | 读宿主 home、credential store、相邻未授权文件；写 package/input/宿主任意路径；symlink、hardlink、rename、path replacement、special file 逃逸 |
| 网络 | IPv4/IPv6 loopback、LAN、Internet、metadata endpoint、DNS/UDP、raw socket；Unix socket/Windows named pipe；macOS Apple Events/LaunchServices |
| 进程/IPC | ptrace/task port/OpenProcess、读取其它进程环境、继承未授权 fd/handle、COM/DBus/keyring、计划任务/服务/代理进程逃逸 |
| CPU | 无限循环受到 kernel/Job/VM 层速率或总量限制，并在 wall timeout 后终止 |
| 内存 | Worker 与全部 descendants 合计超过 hard limit 后分配失败或被边界终止，Runtime 保持存活 |
| 进程数 | fork/spawn bomb 达到上限后创建失败，不能在边界外留下 surrogate process |
| 磁盘 | output/temp 写满固定配额后返回 ENOSPC/等价错误，不能消耗配额外宿主空间 |
| 输出 | stdout、stderr、协议 frame、Artifact 数量/总字节超过上限后 fail closed |
| 清理 | 正常、崩溃、取消、超时、Runtime shutdown 后无 child、VM、pipe/socket、mount、Job/cgroup、scratch lease |

### 3.3 平台证据 Gate

仅看到 Worker 退出码不够，还要读取边界自己的证据：

- Linux：`memory.events`、`pids.events`、`cpu.stat`，终止后 `cgroup.events populated=0`，scratch mount 已卸载；
- Windows VM：QEMU Job completion/accounting 与 active process 为零、LPAC profile/ACL 已回收、Guest attestation 无网络设备且只读 media/固定 scratch/cgroup 与磁盘清理全部成立；
- macOS VM：配置中无 network device，memory/CPU/storage 参数与 frozen limits 一致，VM 已停止，所有 disk/socket attachment 已关闭并删除。

### 3.4 发布矩阵

Gate 按 OS + arch + adapter version + policy digest 独立记录：

| Target | 当前判断 | 打开非受信任 Gate 前的最后条件 |
| --- | --- | --- |
| `linux/x86_64` | 方案成立，未验证 | packaged SRT/bwrap + seccomp + delegated cgroup v2 + sized tmpfs 全套 Gate |
| `linux/arm64` | 方案成立，未验证 | 同上，且 seccomp filter/guest binaries 为 arm64 |
| `windows/x86_64` | QEMU Linux VM 方向成立，未验证 | LPAC VMM + Job + TCG/WHPX + read-only ISO + fixed RAW scratch + Guest/cancel/escape packaged Gate |
| `windows/arm64` | QEMU WHPX 有上游支持，无本项目架构证据 | 同上，且 QEMU、kernel、Guest、launcher 与 Worker 全为 arm64 验证 |
| `darwin/x86_64` | 原生不成立；VM 候选 | Intel Linux guest image + Virtualization.framework packaged Gate |
| `darwin/arm64` | 原生不成立；VM 候选 | arm64 Linux guest image + Virtualization.framework packaged Gate |

通过一个 target 不会自动打开其它 target。CI 模拟器、Docker-in-Docker 或 source-tree test 不能替代对应真实 OS 的 packaged conformance。

## 4. 实施顺序

1. 保持当前 Registry fail closed；先冻结共同 `SandboxLimits` 和平台证据结构，不改变 Worker JSON-RPC。
2. 先完成 Linux adapter：它的 primitive 最成熟，也能验证公共 Gate harness。
3. 完成 Windows LPAC/Job QEMU launcher、跨平台只读 ISO builder 和 x86_64 Linux Guest；先在 TCG 跑完整 Gate，再在 WHPX 真机验证加速路径。
4. 完成 macOS Virtualization.framework spike：只验证冷启动、Virtio socket、无网络、固定 memory/disk 和销毁，不先做 snapshot/pool。
5. 将同一恶意 probe package 跑遍六个 target；只有 blocker 集合为空的 target 才由 Registry 允许启用非受信任 Managed Worker。
6. 最后再迁移 Office/PDF/Media/OCR/Speech 等真实插件；不要让业务 fixture 代替平台安全 Gate。

## 5. 明确不采用

- 不把 Electron renderer `sandbox` 当作 Worker sandbox。
- 不把 cwd、清空 env、普通 child process、进程组 kill、签名或确认弹窗当作权限隔离。
- 不把 parent RSS/free-space poller 当作 hard resource limit。
- 不因为 SRT/Codex/Pi 显示“sandboxed command”就设置 `resource_isolated=true`。
- 不为了统一实现而在 macOS 上伪造 native hard sandbox；统一协议比统一 primitive 更重要。
- 不默认依赖远程 provider；它可以以后作为显式安装的 executor，但不改变本地 Runtime 的开源边界。
