import { describe, expect, it } from 'vitest'
import { analyzeResearchDiagnostics } from './researchDiagnostics.js'
import type { LocalRunDiagnostics, SerializedEvent } from '../types.js'

function event(seq: number, eventType: string, payload: Record<string, unknown> = {}): SerializedEvent {
  return {
    id: `event-${seq}`,
    run_id: 'run-test',
    seq,
    event_type: eventType,
    payload,
    created_at: `2026-05-13T00:00:${String(seq).padStart(2, '0')}Z`,
  }
}

function diagnostics(events: SerializedEvent[]): LocalRunDiagnostics {
  return {
    schema_version: 1,
    exported_at: '2026-05-13T00:01:00Z',
    local_host_version: '0.1.0',
    run: {
      id: 'run-test',
      goal: '请搜索今天最新的 AI 新闻，收集 2 个可信来源，给我一个中文摘要，并列出来源链接。',
      status: 'completed',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:01:00Z',
      completed_at: '2026-05-13T00:01:00Z',
      events_count: events.length,
    },
    events,
    permissions: [],
    artifacts: [],
    latest_checkpoint: null,
  }
}

describe('research diagnostics analyzer', () => {
  it('passes a concise research run with two collected sources and matching citations', () => {
    const analysis = analyzeResearchDiagnostics(diagnostics([
      event(1, 'run.created'),
      event(2, 'source.collected', { url: 'https://example.com/a', title: 'A' }),
      event(3, 'source.collected', { url: 'https://example.com/b', title: 'B' }),
      event(4, 'run.completed', {
        final: '来源链接\n1. https://example.com/a\n2. https://example.com/b',
      }),
    ]))

    expect(analysis.passed).toBe(true)
    expect(analysis.summary.collectedSources).toBe(2)
    expect(analysis.findings).toEqual([])
  })

  it('flags metered web.search calls after enough source evidence has been collected', () => {
    const analysis = analyzeResearchDiagnostics(diagnostics([
      event(1, 'source.collected', { url: 'https://example.com/a', title: 'A' }),
      event(2, 'source.collected', { url: 'https://example.com/b', title: 'B' }),
      event(3, 'tool.completed', { tool: 'web.search', tool_call_id: 'call-extra' }),
      event(4, 'run.completed', {
        final: '来源链接\n1. https://example.com/a\n2. https://example.com/b',
      }),
    ]))

    expect(analysis.passed).toBe(false)
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'metered_search_after_enough_sources',
          seq: 3,
        }),
      ]),
    )
  })

  it('flags final answer URLs that were not collected as sources', () => {
    const analysis = analyzeResearchDiagnostics(diagnostics([
      event(1, 'source.collected', { url: 'https://example.com/a', title: 'A' }),
      event(2, 'source.collected', { url: 'https://example.com/b', title: 'B' }),
      event(3, 'run.completed', {
        final: '来源链接\n1. https://example.com/a\n2. https://example.net/not-opened',
      }),
    ]))

    expect(analysis.passed).toBe(false)
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'uncollected_final_citation',
          detail: expect.stringContaining('https://example.net/not-opened'),
        }),
      ]),
    )
  })
})
