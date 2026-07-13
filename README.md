<div align="center">

# 石间 · SheJane

### A local-first desktop Agent Runtime

Run tool-using agents with workspaces, permissions, checkpoints, skills, and MCP on your own machine.

[![CI](https://img.shields.io/github/actions/workflow/status/jimmyrogue/SheJane/ci.yml?branch=main&style=flat-square&logo=githubactions&label=CI)](https://github.com/jimmyrogue/SheJane/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jimmyrogue/SheJane?style=flat-square&logo=github&label=release)](https://github.com/jimmyrogue/SheJane/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-B3532F?style=flat-square&logo=gnu)](./LICENSE)
![Desktop](https://img.shields.io/badge/desktop-macOS%20%7C%20Windows-2B2A28?style=flat-square&logo=electron)

English · [简体中文](./README.zh-CN.md)

</div>

> [!NOTE]
> Desktop and Runtime are standalone. Go Cloud and Admin remain in this repository as optional, separately released services; neither is required to run the desktop harness.

## Why SheJane

- The local Runtime owns the agent loop, tool execution, permissions, checkpoints, and workspace access.
- The Electron app is the official desktop client, not the execution kernel. Future clients can use the same Runtime protocol.
- Skills, MCP servers, and subagents extend the Runtime without adding product-specific integrations to its core.

## How it fits together

```mermaid
flowchart LR
    D["Desktop client<br/>Electron + React"] -->|"Loopback HTTP + SSE"| R["SheJane Runtime<br/>Python + LangGraph"]
    R --> W["Local workspace<br/>Files · Tools · Checkpoints"]
    R --> E["Extensions<br/>Skills · MCP · Subagents"]
    R --> B["BYOK providers<br/>OpenAI-compatible APIs · local endpoints"]
    C["Optional Go Cloud + Admin"] -. "standard provider or MCP only" .-> R
```

The desktop client and Runtime communicate over loopback HTTP with a pairing token. A failed local Runtime should surface as a local error, not silently create a cloud task.

## What is included

| Area | Current implementation |
|---|---|
| Runtime | LangGraph and Deep Agents loop, streaming events, checkpoints, recovery, planning, verification, memory, and human approval |
| Local tools | Workspace files, shell execution, Office operations, web fetch, clipboard approval, and scheduled runs |
| Extensions | Skills, MCP servers, subagents, and configurable middleware |
| Desktop | Electron and React client, local-first chat history, previews, provider settings, and workspace controls |
| Optional Cloud | Authentication, billing, documents, service tools, and Admin APIs, released independently |
| Runtime SDK | Public TypeScript client for commands, SSE, snapshots, errors, and generated protocol types |

Business-platform connectors are not built into the Runtime. Future integrations should use standard tools or MCP.

## Quick start

Desktop development requires **Node.js 22+ with Corepack**, **Python 3.12+**, and [uv](https://docs.astral.sh/uv/). Go and Docker are only needed for the optional Cloud services.

```bash
make setup-hooks
corepack enable && pnpm install
make dev-electron
```

No root `.env` is required. Start Desktop, add an OpenAI-compatible provider in Runtime settings, then select one of its models. Use `make doctor` when the local stack does not start cleanly.

## Development

```bash
make lint        # format, static checks, and secret-boundary checks
make test        # Go, Python, desktop client, and admin tests
make build       # production builds
```

## Documentation

- [Runtime stages](./docs/harness-runtime-stages.md) defines the target P1–P12 architecture.
- [Current run loop](./docs/run-loop.md) describes what the code does today.
- [Improvement notes](./docs/harness-stage-improvement-notes.md) records keep, replace, and delete decisions.
- [Contributor guide](./CONTRIBUTING.md) covers setup, testing, and the CLA process.
- [Operations](./docs/operations.md) covers deployment and troubleshooting.

## License

Copyright © 2026 [TAO LIANG](mailto:tliang92@gmail.com).

SheJane uses a dual-license model:

- Community use is available under [GNU AGPL v3.0 only](./LICENSE).
- Proprietary distribution, closed-source modification, embedding, and white-label use require a [separate commercial license](./COMMERCIAL_LICENSE.md).

The SheJane name and logo are covered by the [Trademark and Brand Policy](./TRADEMARKS.md). External contributions require agreement to the [Contributor License Agreement](./CLA.md). Third-party components keep their own licenses as listed in [Third-Party Notices](./THIRD_PARTY_NOTICES.md).
