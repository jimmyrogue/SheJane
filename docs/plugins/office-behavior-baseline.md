# Office behavior baseline

> Captured: 2026-07-15 from `runtime/src/shejane_runtime/tools/office.py`
>
> Evidence: `uv run python -m pytest tests/test_tools_office.py -q` → `51 passed`

This is the migration baseline for the future Documents, Spreadsheets, and Presentations Managed Worker plugins. It records observable behavior, not the current Python API or file layout.

## Shared invariants

- Read and write paths remain inside the authorized Run workspace.
- Existing files use copy-on-first-write: `<name>.edited.<ext>` is reused by later edits.
- Original source bytes remain unchanged.
- Writes use a temporary file, reopen/verify the result, then replace the target.
- Verification failure preserves the last known-good target and removes the temporary file.
- Unsupported extensions and invalid arguments fail before producing an edited copy.

## Documents baseline

- Read DOCX as bounded Markdown and return headings/table/paragraph outline metadata.
- Find/replace with an optional global count limit.
- Insert after an anchor or at the end with an optional style.
- Replace or delete one matching paragraph.
- Apply a named paragraph style and verify it after reopen.

The plugin migration must additionally add production document rendering, page-count extraction, corrupted/encrypted input handling, and layout-fidelity fixtures. The Phase 0 Documents Worker is only a protocol fixture, not the production renderer.

## Spreadsheets baseline

- Read XLSX as bounded Markdown; list sheet names and dimensions.
- Read a rectangular range with separate values and formula grids.
- Write a 2D cell block without changing unrelated cells.
- Store formula literals beginning with `=`.
- Apply bold/font/background formatting.
- Merge cells and append or insert rows.
- Reopen the workbook to verify all edits.

Current code does not calculate formulas. The production plugin must define a real recalculation engine and golden cases for formulas, dates, locale, merged cells, named ranges, charts, and formatting. A cached value of `None` from openpyxl is not successful recalculation.

## Presentations baseline

- Create a new PPTX without creating an edited copy first.
- Read structured slide title, bullets, and speaker notes.
- Add, update, delete, and reorder slides.
- Set title, bullets, and speaker notes.
- Add an image and preserve expected geometry.
- Reopen the deck and verify slide count/order/content.
- Preserve the last known-good deck when verification fails.

The production plugin must add rendering-based checks for layout, fonts, overflow, theme fidelity, images, and platform differences.

## Plugin parity gate

For each migrated Action, run the same logical fixture through the current core tool and the candidate Worker, then compare:

1. success/failure category and structured summary;
2. source SHA-256 remains unchanged;
3. output reopens in an independent parser;
4. document structure, formulas, styles, slide order, notes, and media relationships;
5. LibreOffice/Microsoft Office render output where applicable;
6. atomic failure behavior and absence of partial Artifact promotion.

OOXML byte-for-byte equality is not required because ZIP ordering and metadata may vary. Logical structure and rendered output are the authority. Core Office registration is removed only after every listed behavior has a plugin parity test and the production rendering gaps are closed.

## Phase 5 engine decision

The current Runtime has OOXML structure libraries but no product-owned rendering or recalculation engine. A `soffice` binary found in a developer/Codex environment or a locally installed Microsoft Office application is not a SheJane capability and cannot be used as an implicit fallback.

Documents, Spreadsheets, and Presentations now bind the same exact, platform-specific LibreOffice/MuPDF Runtime Asset rather than embedding or discovering an Office installation:

- structural read/edit keeps the current explicit OOXML behavior contract;
- a fresh LibreOffice user profile lives under the invocation output staging root;
- headless load/save supplies independent reopen verification and, for Calc later, formula recalculation;
- PDF export uses LibreOffice's documented headless filter path; PNG previews rasterize that PDF with a pinned in-package renderer;
- package fonts and locale/timezone fixtures define the reproducible baseline; host user fonts and preferences remain outside the sandbox;
- Microsoft Office may be a native-runner comparison oracle for golden fixtures, never a runtime dependency or silent fallback.

LibreOffice officially supports headless/API control and PDF export filters, while LibreOfficeKit provides C/C++ tiled rendering and underpins LibreOffice Online/mobile. The first Worker should use the smaller process boundary (`soffice --headless` plus staged files); adopt LibreOfficeKit only if measured PDF/raster output cannot satisfy the rendering Gate, rather than maintaining two rendering paths from day one. [LibreOffice start parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) [PDF export parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html) [LibreOffice developer guide](https://wiki.documentfoundation.org/Documentation/DevGuide/FirstSteps/First_Steps)

ONLYOFFICE DocumentServer is not the local default: its Community Edition is a server-shaped AGPL deployment and its Document Builder/Automation service is reserved for commercial editions, which adds a service and licensing boundary without improving SheJane's local Worker protocol. [ONLYOFFICE DocumentServer](https://github.com/ONLYOFFICE/DocumentServer)

The shared Runtime Asset contract, digest, license/SBOM metadata, P6 lease, and P10 read-only mapping are implemented. On a macOS arm64 host, Documents, Spreadsheets, and Presentations now run as frozen Linux/arm64 Workers inside the production VM against the same frozen Linux/arm64 LibreOffice/MuPDF Asset; all three rich golden cases pass. Every additional execution ABI still requires its own Asset, Worker, sandbox, and golden evidence. The Asset remains a narrow host-managed byte bundle, not a third plugin type or a general dependency graph.
