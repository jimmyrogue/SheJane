/**
 * Contract round-trip tests — real HTTP against a live daemon.
 *
 * Catches every shape drift between TS client + Python daemon that
 * the regular `client.test.ts` (MockTransport) can't see. The
 * Phase 5'+ migration shipped with 9+ silent contract drifts; this
 * suite is the floor that keeps them from coming back.
 *
 * Skipped entirely when `VITE_TEST_LOCAL_HOST_URL` isn't set so
 * `pnpm test` stays hermetic. CI sets it after starting the daemon.
 *
 * Tests target the SYNCHRONOUS endpoints — health, session, runs
 * CRUD, permissions. SSE stream tests would require a real
 * upstream LLM (or a complex daemon mock mode) and are deferred.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  probeLocalHost,
  createLocalRun,
  listLocalRuns,
  streamLocalRun,
  authorizeLocalWorkspace,
  listAuthorizedWorkspaces,
  revokeLocalWorkspace,
} from './client'

const BASE_URL = process.env.VITE_TEST_LOCAL_HOST_URL
const TOKEN = process.env.VITE_TEST_LOCAL_HOST_TOKEN ?? 'dev-local-token'
const CONTRACT_SETTINGS = { memory: 'off', skills: 'off', mcp: 'off' } as const
const CONTRACT_MODE = 'local:test:model'

// Vitest 2.x — describe.skipIf(condition) drops the whole block.
describe.skipIf(!BASE_URL)('contract: local-host HTTP (live daemon)', () => {
  const config = { baseURL: BASE_URL!, token: TOKEN }

  // -----------------------------------------------------------------
  // GET /local/v1/health
  // -----------------------------------------------------------------
  describe('probeLocalHost', () => {
    it('reports online=true via {status: "ok"} envelope', async () => {
      const probe = await probeLocalHost(BASE_URL!)
      expect(probe.online).toBe(true)
      expect(probe.status).toBe('ok')
    })
  })

  // -----------------------------------------------------------------
  // POST/GET /local/v1/runs — flat shape, list endpoint exists
  // -----------------------------------------------------------------
  describe('runs', () => {
    it('POST returns flat LocalRun (no {run: ...} wrapper)', async () => {
      const run = await createLocalRun(
        {
          commandId: 'cmd_contract_create',
          clientMessageId: 'msg_contract_create',
          goal: 'contract test run',
          mode: CONTRACT_MODE,
          settings: CONTRACT_SETTINGS,
        },
        config,
      )
      expect(run.id).toMatch(/^run_/)
      expect(run.goal).toBe('contract test run')
      expect(run.status).toMatch(/queued|running|completed/)
      // Anti-regression — earlier daemon wrapped in {run: ...}.
      expect((run as unknown as { run?: unknown }).run).toBeUndefined()
    })

    it('GET /runs returns the list (not 404)', async () => {
      // Just smoke that the route is registered and returns an array.
      // listLocalRuns wraps the actual fetch; if the route 404s the
      // helper throws.
      const runs = await listLocalRuns(config)
      expect(Array.isArray(runs)).toBe(true)
    })

    it('previously-created run appears in list with envelope fields', async () => {
      const created = await createLocalRun(
        {
          commandId: 'cmd_contract_list',
          clientMessageId: 'msg_contract_list',
          goal: 'list-me',
          mode: CONTRACT_MODE,
          settings: CONTRACT_SETTINGS,
        },
        config,
      )
      const runs = await listLocalRuns(config)
      const found = runs.find((r) => r.id === created.id)
      expect(found).toBeDefined()
      expect(found?.goal).toBe('list-me')
    })
  })

  // -----------------------------------------------------------------
  // SSE stream — the most drift-prone interface (invariant #3). This test's
  // job is the CLIENT side: that streamLocalRun → parseAgentSSE reads the
  // live wire envelope correctly (event_type populated, terminal events
  // delivered, completion flagged). The content/event payloads themselves are
  // asserted deterministically daemon-side in test_sse_contract.py (which
  // drives the fake model in-process), so we don't re-assert streamed text
  // here — that depends on the subprocess picking up SHEJANE_FAKE_LLM, which
  // isn't this layer's contract.
  // -----------------------------------------------------------------
  describe('runs stream', () => {
    it('parses the SSE envelope: event_type populated, run.started/completed delivered', async () => {
      const created = await createLocalRun(
        {
          commandId: 'cmd_contract_stream',
          clientMessageId: 'msg_contract_stream',
          goal: 'contract stream',
          mode: CONTRACT_MODE,
          settings: CONTRACT_SETTINGS,
        },
        config,
      )
      const events: string[] = []
      const result = await streamLocalRun(created.id, config, {
        onEvent: (event) => events.push(event.event_type),
        onDelta: () => {},
      })

      // The client parsed real envelopes off the wire (event_type populated,
      // never undefined — the silent-no-op bug this guards against).
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((name) => typeof name === 'string' && name.length > 0)).toBe(true)
      expect(events).toContain('run.started')
      expect(events).toContain('run.completed')
      expect(result.completed).toBe(true)
    })
  })

  // -----------------------------------------------------------------
  // POST/DELETE /local/v1/workspaces — flat shape
  // -----------------------------------------------------------------
  describe('workspaces', () => {
    it('POST returns flat LocalWorkspaceAuthorization (no wrapper)', async () => {
      const path = mkdtempSync(join(tmpdir(), 'shejane-contract-ws-'))
      const ws = await authorizeLocalWorkspace(path, config)
      expect(ws.id).toBeTruthy()
      expect(ws.path).toBe(realpathSync(path))
      expect((ws as unknown as { workspace?: unknown }).workspace).toBeUndefined()

      // Cleanup
      await revokeLocalWorkspace(ws.id, config)
      rmSync(path, { recursive: true, force: true })
    })

    it('DELETE returns the deleted record (flat shape)', async () => {
      const path = mkdtempSync(join(tmpdir(), 'shejane-contract-del-'))
      const ws = await authorizeLocalWorkspace(path, config)
      const deleted = await revokeLocalWorkspace(ws.id, config)
      // Returns the deleted record, NOT {deleted: bool}.
      expect(deleted.id).toBe(ws.id)
      expect(deleted.path).toBe(ws.path)
      rmSync(path, { recursive: true, force: true })
    })

    it('list returns LocalWorkspaceAuthorization[] from {workspaces} envelope', async () => {
      const path = mkdtempSync(join(tmpdir(), 'shejane-contract-list-'))
      const ws = await authorizeLocalWorkspace(path, config)
      const all = await listAuthorizedWorkspaces(config)
      expect(Array.isArray(all)).toBe(true)
      expect(all.find((w) => w.id === ws.id)).toBeDefined()
      await revokeLocalWorkspace(ws.id, config)
      rmSync(path, { recursive: true, force: true })
    })
  })

  // -----------------------------------------------------------------
  // Error shape — FastAPI `detail` is what daemon emits.
  // localErrorMessage must surface it (not the generic HTTP code).
  // -----------------------------------------------------------------
  describe('error shape', () => {
    it('POST /runs with missing goal returns readable message', async () => {
      try {
        await createLocalRun(
          { commandId: 'cmd_contract_empty', clientMessageId: 'msg_contract_empty', goal: '', mode: CONTRACT_MODE },
          config,
        )
        expect.fail('expected error from empty goal')
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // Should be the specific "goal required" message from the
        // daemon's HTTPException(detail=...), NOT a generic
        // "Local Host HTTP 400". Anti-regression for client.ts
        // localErrorMessage reading `body.detail`.
        expect(msg.toLowerCase()).toContain('goal')
      }
    })
  })
})
