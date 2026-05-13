# Phase 3 UI / Smooth Streaming Progress

**Status:** in progress  
**Started:** 2026-05-13
**Latest update:** 2026-05-13

## Goal

Upgrade the user client into an Electron-first Agentic Chat experience:

- shadcn/ui + Tailwind v4 foundation aligned with admin.
- Smooth streaming that decouples network chunks from React renders.
- Componentized chat shell instead of a monolithic `App.tsx`.
- Professional Agent timeline, permission, source, artifact, and diagnostics surfaces.

## Implemented

- Added client shadcn/ui setup:
  - `components.json`
  - Tailwind v4 Vite plugin
  - `@/*` alias
  - `cn()` utility
  - shadcn components: button, card, sidebar, scroll-area, sheet, dialog, tabs, badge, avatar, separator, tooltip, skeleton, input, textarea, alert, sonner.
- Added `StreamTransport` abstraction and shared Agent SSE streaming parser.
- Reused the shared transport in cloud Agent Run stream and Local Harness stream.
- Added smooth streaming hooks:
  - `useSmoothTextStream`
  - `useSmartAutoScroll`
- Split client UI into:
  - `AuthScreen`
  - `ConversationSidebar`
  - `ChatThread`
  - `MessageBubble`
  - `AgentTimeline`
  - `Composer`
  - `ArtifactPanel`
  - `DiagnosticsPanel`
- Streaming messages render lightweight animated text while streaming and Markdown/GFM after completion.
- Current conversation updates are throttled during cloud/local streams so the UI can show progress without per-token render pressure.
- Added Phase 3.1 UI refinement:
  - switched the client visual system to a monochrome business palette using semantic shadcn/Tailwind tokens.
  - replaced the inline full Agent timeline with compact `AgentProgress`, showing only the latest task state plus source/artifact summaries.
  - kept permission approval actions, artifact preview, diagnostics panel, and diagnostics export intact.
  - added responsive CSS for desktop, tablet, and narrow Web/Electron windows.

## OpenBridge Reference Decision

OpenBridge is useful as a reference for:

- native shell + embedded React chat surface
- bridge contract between native host and web UI
- streaming markdown / deferred render
- smart auto-scroll behavior

Jiandanly does not copy OpenBridge's BYOK/provider architecture, SwiftUI/WebKit implementation, or sandbox VM approach.

## Verification

- `cd client && npm test -- --run src/shared/streaming/useSmoothTextStream.test.tsx src/shared/streaming/useSmartAutoScroll.test.tsx src/shared/streaming/streamTransport.test.ts`
- `cd client && npm test -- --run src/App.test.tsx`
- `cd client && npm run build`
- `cd client && npm test -- --run src/features/chat/components/AgentProgress.test.tsx src/App.test.tsx`
- `make test`
- `make build`
- `make test-e2e`
- Playwright viewport smoke at 1280px, 768px, and 375px confirmed no horizontal overflow and no full source-event list in chat body.

## Remaining

- Continue replacing legacy CSS selectors with pure semantic Tailwind/shadcn composition.
- Add Playwright E2E coverage for smooth streaming and user-scroll behavior.
- Add Electron MessagePort transport only when profiling shows IPC/main-process streaming is the bottleneck.
- Consider a true mobile sidebar drawer if the Web fallback becomes a first-class phone experience; current Phase 3.1 keeps the sidebar as a compact top panel on narrow widths.
