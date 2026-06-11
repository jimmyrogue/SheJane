# Universal Tool Primitives Spec

**Status:** Phase 2.15 implementation spec; Phase 2.16 adds observation primitives on top
**Updated:** 2026-05-11

> **Current-state note (2026-06-10):** this file is a design spec for the
> universal primitive vocabulary, not the current implementation source of
> truth. The current Python/LangGraph daemon uses deepagents-provided
> filesystem/shell tool names (`ls`, `read_file`, `write_file`, `edit_file`,
> `glob`, `grep`, `execute`) plus SheJane tools such as `workspace.open`,
> `web.fetch`, `web.search`, `open.*`, `clipboard.*`, `task.verify`,
> `memory.search`, office tools, MCP tools, and gateway-backed paid tools.
> Granular `browser.open/read/verify/snapshot/...` primitives are not
> currently registered; `browser.task` is hidden until browser-use and a
> browser LLM are wired. See [run-loop.md](../run-loop.md) and
> [operations.md](../operations.md) for current behavior.

## Summary

Universal Tool Primitives turn the SheJane Local Harness from a coding-oriented tool loop into a general work-agent foundation. The model should reason in simple verbs: read, write, open, search, list, and verify. Higher-level office automation, browser work, documents, spreadsheets, email, and calendar flows should compose these primitives instead of creating one-off scene tools.

## Tool Shape

Tool names use object-domain prefixes:

- `fs.*` for authorized local workspace files and folders.
- `open.*` for opening user-visible system targets.
- `clipboard.*` for plain-text clipboard operations.
- `browser.*` for Local Host managed page observation.
- `environment.observe` for user-approved local environment metadata.
- `task.verify` for simple result checks.
- Existing `file.*` tools remain legacy aliases for compatibility.

Tool results follow the existing Local Host shape:

- `ok`: whether the tool action succeeded.
- `content`: model-readable observation text.
- `data`: structured metadata, including `source`.
- `errorCode`: stable machine-readable failure code.
- `recoverable`: whether the model may adapt and continue.
- Large output should become an artifact instead of filling the prompt.

## Permission Defaults

- `allow`: read-only workspace tools such as `fs.list`, `fs.read`, `fs.search`, `browser.snapshot`, `browser.close`, and `task.verify`.
- `ask`: user-visible, sensitive, or mutating actions such as `fs.write`, `open.url`, `open.file`, `clipboard.read`, `clipboard.write`, `browser.open`, and `environment.observe`.
- `deny`: reserved for future policy rules; denied tools should not be exposed to the model.

All workspace tools must stay inside authorized workspace roots. Clipboard tools handle text only. `open.url` supports `http` and `https` only. `open.file` only opens files under an authorized workspace.

## Phase 2.15 Tools

| Tool | Permission | Purpose |
|---|---:|---|
| `fs.list` | allow | List files and folders in an authorized workspace directory. |
| `fs.read` | allow | Read a file in an authorized workspace. |
| `fs.search` | allow | Search filenames and text in an authorized workspace. |
| `fs.write` | ask | Create or overwrite UTF-8 text inside an authorized workspace. |
| `open.url` | ask | Open an HTTP(S) URL in the system default browser. |
| `open.file` | ask | Open an authorized workspace file in the system default app. |
| `clipboard.read` | ask | Read plain text from the clipboard. |
| `clipboard.write` | ask | Write plain text to the clipboard. |
| `task.verify` | allow | Verify simple file, URL, or boolean conditions. |

## Phase 2.16 Observation Tools

| Tool | Permission | Purpose |
|---|---:|---|
| `browser.open` | ask | Open a public HTTP(S) URL in the Local Host managed page context and capture the first snapshot. |
| `browser.snapshot` | allow | Observe the managed page title, URL, visible text, links, forms, and buttons. |
| `browser.close` | allow | Clear the managed page context. |
| `environment.observe` | ask | Observe platform, foreground app, window title, and screen-permission metadata. |

## Boundary

These primitives are intentionally lower-level than business workflows. A future "summarize downloaded PDFs and draft an email" flow should be built by combining file listing, file reading, document parsing, clipboard/open actions, and verification events. It should not become a hardcoded single-purpose tool.

Browser observation is intentionally not full Computer Use. Phase 2.16 does not inspect existing browser tabs, click, type, submit forms, capture screenshots, or control other applications.
