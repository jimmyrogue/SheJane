/**
 * Vitest config for the contract round-trip suite.
 *
 * Why a separate config: contract tests run against a REAL daemon
 * over HTTP (no MockTransport) — they shouldn't run as part of the
 * default `pnpm test` (which is meant to be hermetic and fast). CI
 * boots a fresh daemon, sets VITE_TEST_LOCAL_HOST_URL, then runs
 * `pnpm test:contract`.
 *
 * Local dev: skip the whole file with `vi.skipIf(!BASE_URL)` so
 * `pnpm test` keeps running without a daemon.
 *
 * What it catches: every shape drift this codebase has seen across
 * the Phase 5'+ migration — `data: [DONE]` sentinel, AgentRunEvent
 * envelope keys, flat-vs-wrapped POST /runs response,
 * Runtime response fields and endpoint contracts.
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Real fetch needs node env (jsdom's fetch shim is unreliable
    // with streaming + abort signals).
    environment: 'node',
    include: ['src/**/*.contract.test.ts'],
    // No setupFiles — those exist for jsdom + IndexedDB shims that
    // contract tests don't need.
    testTimeout: 30_000, // SSE streams can take a few seconds.
  },
})
