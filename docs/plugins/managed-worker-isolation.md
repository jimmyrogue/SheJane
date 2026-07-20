# Managed Worker isolation status

> Current decision: use platform-specific complete backends. Linux uses frozen Bubblewrap + native seccomp/cgroup/tmpfs/Artifact broker; macOS uses Virtualization.framework; Windows uses a QEMU Linux MicroVM whose VMM is confined by LPAC/AppContainer and a complete Job Object. Anthropic Sandbox Runtime 0.0.65 remains only as an access-layer comparison and old-path fixture. See [`managed-worker-agent-sandbox-research.md`](managed-worker-agent-sandbox-research.md) and [`managed-worker-windows-linux-isolation-research.md`](managed-worker-windows-linux-isolation-research.md). All targets remain fail closed until their packaged Gate passes.

This status is independent of publisher, signature, or whether a plugin is maintained in the SheJane repository. A valid signature does not change it.

| Platform | Proved now | Missing before untrusted enablement | Current policy |
| --- | --- | --- | --- |
| macOS arm64 | Virtualization.framework boot; deterministic static `guestd`; no network device; bounded control/Artifact VSOCK; deterministic ext4 package/input/scratch; read-only and non-remountable input; fixed scratch with `ENOSPC`; invocation-private scratch-backed `/tmp` with `noexec,nodev,nosuid`; UID/GID 65534 Worker; descendant group OOM and PID rejection; 1 vCPU + cgroup CPU cap; production Executor roundtrip and P6 VM asset preflight; succeeded/failed/malformed frames; hostile/oversized Artifact rejected; ignored cancellation ends in `cgroup.kill → populated 0 → stopped`; invocation image staging cleanup; reproducible official-source VM asset set; packaged launcher entitlement/transport; exact final-App asset identity; packaged 14-mode static-Worker VM Gate; Worker/descendant host file, credential, PID, Unix socket, host-loopback and external-network isolation; Worker/launcher crash cleanup; Runtime `SIGKILL` lease recovery; normal packaged Client P1 startup/manifest injection/quit cleanup; frozen read-only Debian rootfs; real Python onedir and Node.js Runtime Asset; three Office/LibreOffice rich goldens; PDF/MuPDF Unicode-hostile-cancel Gate; Media/FFmpeg exact-output-hostile-cancel Gate; OCR/RapidOCR multilingual-layout-rotation-hostile-cancel Gate; Speech/Whisper repeatability-bilingual-hostile-cancel-performance Gate; Cloud Vision bounded VSOCK host-call and Runtime credential/image/provider adapter Gate | Real Developer ID/notarization release-runner execution | Static and dynamic Worker backends plus P1 entry and attack/cleanup Gate proved; only `release_ci_gate` remains; Registry disabled |
| macOS x64 | No architecture-specific VM proof | Linux x86_64 guest builder/assets plus the complete native x64 Gate | `proved=()`, `architecture_conformance_gate`; Registry disabled |
| Windows | Design corrected to LPAC-confined QEMU Linux VM. Linux/arm64-hosted QEMU TCG has booted the AMD64 Guest and passed read-only ISO, fixed scratch-backed `/tmp`, cgroup and full Worker protocol candidate checks. A Win32 LPAC/Job/zero-network/`LOCAL` Named Pipe self-test and `windows-latest` gate now exist, but have no Windows-host result yet | Frozen QEMU supply chain; successful Windows host gate; Windows TCG/WHPX boot; Guest Artifact, descendant, cancel, escape, ENOSPC and packaged cleanup tests | `windows_qemu_linux_vm_v1`, `proved=()`, `sandboxed=false`, untrusted disabled |
| Linux arm64 | Frozen Bubblewrap 0.11.2 + native Go launcher; read-only host/package/input; private PID/network/IPC/UTS/mount namespaces; arch seccomp; nested user namespace denial; fixed tmpfs scratch with `ENOSPC`; broker-only host output descriptor and declared-Artifact promotion; atomic cgroup entry, hard memory/pids/CPU policy, ignored-cancel descendant kill and leaf cleanup. Docker Desktop Linux/arm64 passed the production Executor Gate. | Final PyInstaller Gate inside a real `Delegate=yes` + `DelegateSubgroup=` systemd service; release workflow execution | `linux_bwrap_cgroup_v1`; proved checks recorded, but `systemd_delegation_gate` and `release_ci_gate` keep Registry disabled |
| Linux amd64 | Source compiles and vets for amd64; no native execution proof | Complete native amd64 packaged and systemd Gate | `proved=()`, architecture/systemd/release blockers; Registry disabled |

The Electron renderer `sandbox` setting is unrelated. Changing cwd, removing environment variables, signing the package, requiring confirmation, using a Job Object alone, or killing descendants does not reduce the worker's current-user file/network authority.

## Runtime rule

The Worker handshake reports separate facts. `sandboxed` is the conjunction of enforced
access and hard resource isolation; it is never an alias for “a launcher was used”:

```json
{
  "protocol_version": 1,
  "process_isolated": true,
  "access_isolated": true,
  "resource_isolated": false,
  "sandboxed": false
}
```

Phase 0 accepts this state only for repository test fixtures invoked directly by conformance tests. The future PluginRegistry policy must reject enabling an untrusted `managed_worker` whenever `sandboxed` is false. There is no warning-dialog override.

Each platform adapter must later prove, from the worker and a spawned descendant:

- undeclared host files and credential stores cannot be opened;
- loopback, LAN, internet, and metadata endpoints cannot be reached;
- unrelated processes and privileged IPC cannot be inspected or contacted;
- only authorized input and private staging are visible;
- CPU, memory, process count, disk, stdout/stderr, and wall time are bounded;
- cancellation and Runtime shutdown leave no descendant, pipe, or staging lease.

Failure to initialize the OS primitive, a missing kernel feature, an unsigned/mis-entitled helper, or an unrecognized platform must fail closed. Platform support is three independently tested states, not one cross-platform boolean.

Codex Seatbelt, Pi's SRT example, and SRT itself do not add a macOS hard resource boundary. Deep Agents obtains that property from external sandbox providers. A parent RSS poller can reduce accidental damage but has a race window and is not proof that an untrusted process cannot exhaust the host; it must not set `resource_isolated=true`, `sandboxed=true`, or open the Registry Gate.

Runtime now owns an explicit release matrix (`managed_worker_release_gate`) rather than a
single cross-platform boolean. The matrix records proved checks and blockers for each
target. Registry installation can proceed only when that target's blocker set is empty;
environment variables, package signatures, and Worker-authored handshake values cannot
change the matrix.
