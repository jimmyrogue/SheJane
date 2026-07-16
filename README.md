<div align="center">

# 石间 · SheJane

### A local-first desktop Agent Runtime

Run tool-using agents with workspaces, permissions, checkpoints, Skills, MCP, and deterministic plugins on your own machine.

[![CI](https://img.shields.io/github/actions/workflow/status/jimmyrogue/SheJane/ci.yml?branch=main&style=flat-square&logo=githubactions&label=CI)](https://github.com/jimmyrogue/SheJane/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-B3532F?style=flat-square&logo=gnu)](./LICENSE)
![Desktop](https://img.shields.io/badge/desktop-macOS%20%7C%20Windows-2B2A28?style=flat-square&logo=electron)

English · [简体中文](./README.zh-CN.md)

</div>

## Why SheJane

- The local Runtime owns the agent loop, tool execution, permissions, checkpoints, and workspace access.
- The Electron app is the official desktop client, not the execution kernel. Future clients can use the same Runtime protocol.
- Skills, MCP servers, subagents, and deterministic plugins extend the Runtime without adding product-specific integrations to its core.

## How it fits together

```mermaid
flowchart LR
    D["Desktop client<br/>Electron + React"] -->|"Loopback HTTP + SSE"| R["SheJane Runtime<br/>Python + LangGraph"]
    R --> W["Local workspace<br/>Files · Tools · Checkpoints"]
    R --> E["Extensions<br/>Skills · MCP · Plugins · Subagents"]
    R --> B["BYOK providers<br/>OpenAI-compatible APIs · Anthropic"]
```

The desktop client and Runtime communicate over loopback HTTP with a pairing token. A failed Runtime surfaces as a local error and never switches execution paths silently.

## What is included

| Area | Current implementation |
|---|---|
| Runtime | LangGraph and Deep Agents loop, streaming events, checkpoints, recovery, planning, verification, memory, and human approval |
| Local tools | Workspace files, shell execution, Office operations, web fetch, clipboard approval, and scheduled runs |
| Extensions | Skills, MCP servers, deterministic WASI/Managed Worker plugins, subagents, and configurable middleware |
| Desktop | Electron and React client, local Runtime conversation projection, previews, provider settings, and workspace controls |
| Runtime SDK | Public TypeScript client for commands, SSE, snapshots, errors, and generated protocol types |

Business-platform connectors are not built into the Runtime. Future integrations should use standard tools or MCP.

The plugin platform is a preview. WASI packages can install and execute through the Runtime-owned Action protocol. Managed Worker packages stay fail-closed until the current platform's production isolation and release Gate passes. See the [plugin developer guide](./docs/plugins/developer-guide.md) for the public package contract and local tooling.

## Quick start

Desktop development requires **Node.js 22+ with Corepack**, **Python 3.12+**, and [uv](https://docs.astral.sh/uv/).

```bash
make setup-hooks
corepack enable && pnpm install
make dev-electron
```

No root `.env` is required. Start Desktop, add an OpenAI-compatible or Anthropic provider in Runtime settings, then select one of its models. Use `make doctor` when the local stack does not start cleanly.

## Development

```bash
make lint        # format, static checks, and secret-boundary checks
make test        # Python Runtime, Desktop, and Runtime SDK tests
make build       # production builds
```

## Build Runtime from source

Runtime is not published as a standalone GitHub release. Build it on the operating system and CPU architecture where it will run:

```bash
cd services/runtime
uv sync --frozen
uv run pyinstaller shejane-runtime.spec --noconfirm --clean
```

The bundle is written to `services/runtime/dist/shejane-runtime/`. On Windows, the executable is `shejane-runtime.exe`. PyInstaller includes platform-specific native dependencies, so Runtime cannot be cross-compiled for another operating system or architecture.

## Desktop packages

The Desktop release workflow builds Runtime from the same commit and includes it in each installer. GitHub Actions produces three artifacts:

```text
desktop-macos-arm64
desktop-macos-x64
desktop-windows-x64
```

Run the workflow manually to test packages. Push a `desktop-vX.Y.Z` tag to create a GitHub Release. Runtime SDK packages continue to use `runtime-sdk-vX.Y.Z` tags.

## Documentation

- [Runtime stages](./docs/harness-runtime-stages.md) defines the target P1-P12 architecture.
- [Current run loop](./docs/run-loop.md) describes what the code does today.
- [Runtime protocol](./docs/runtime-protocol.md) defines HTTP, SSE, events, and recovery cursors.
- [Contributor guide](./CONTRIBUTING.md) covers setup, testing, and the CLA process.
- [Operations](./docs/operations.md) covers deployment and troubleshooting.
- [Plugin developer guide](./docs/plugins/developer-guide.md) defines WASI and Managed Worker packages, Actions, validation, and release checks.

## License

Copyright © 2026 [TAO LIANG](mailto:tliang92@gmail.com).

SheJane uses a dual-license model:

- Community use is available under [GNU AGPL v3.0 only](./LICENSE).
- Proprietary distribution, closed-source modification, embedding, and white-label use require a [separate commercial license](./COMMERCIAL_LICENSE.md).

The SheJane name and logo are covered by the [Trademark and Brand Policy](./TRADEMARKS.md). External contributions require agreement to the [Contributor License Agreement](./CLA.md). Third-party components keep their own licenses as listed in [Third-Party Notices](./THIRD_PARTY_NOTICES.md).
