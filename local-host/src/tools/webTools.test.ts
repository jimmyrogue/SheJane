import { describe, expect, it } from 'vitest'
import { executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

const run: LocalRun = {
  id: 'run-web-test',
  goal: 'Use web tools safely.',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('web tools', () => {
  it('fetches text from public http sources and extracts readable text', async () => {
    const result = await executeTool(
      { id: 'call-fetch', name: 'web.fetch', arguments: { url: 'https://example.com/page', maxBytes: 4096 } },
      run,
      {
        resolveHostname: async () => ['93.184.216.34'],
        fetcher: async () =>
          new Response('<html><head><title>Example</title><script>bad()</script></head><body><h1>Hello</h1><p>Readable text.</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      },
    )

    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        url: 'https://example.com/page',
        status: 200,
        content_type: expect.stringContaining('text/html'),
      }),
    })
    expect(result.content).toContain('Hello')
    expect(result.content).toContain('Readable text.')
    expect(result.content).not.toContain('bad()')
  })

  it('blocks localhost and private-network fetch targets before making a request', async () => {
    let called = false
    const result = await executeTool(
      { id: 'call-fetch-private', name: 'web.fetch', arguments: { url: 'http://internal.test/metadata' } },
      run,
      {
        resolveHostname: async () => ['127.0.0.1'],
        fetcher: async () => {
          called = true
          return new Response('private')
        },
      },
    )

    expect(called).toBe(false)
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ssrf_blocked',
      recoverable: true,
    })
  })

  it('uses Tavily search when configured and keeps result size bounded', async () => {
    let request: Request | undefined
    const result = await executeTool(
      { id: 'call-search', name: 'web.search', arguments: { query: 'Jiandanly harness', maxResults: 2 } },
      run,
      {
        tavilyApiKey: 'tvly-test',
        tavilyBaseURL: 'https://api.tavily.local',
        fetcher: async (input, init) => {
          request = new Request(input, init)
          return new Response(
            JSON.stringify({
              query: 'Jiandanly harness',
              answer: 'Harnesses wrap models with tools and state.',
              results: [
                { title: 'Harness docs', url: 'https://example.com/harness', content: 'Tools, memory, and verification.', score: 0.9 },
                { title: 'Agent docs', url: 'https://example.com/agent', content: 'Agent loop and guardrails.', score: 0.8 },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        },
      },
    )

    expect(request?.url).toBe('https://api.tavily.local/search')
    expect(request?.headers.get('authorization')).toBe('Bearer tvly-test')
    await expect(request?.json()).resolves.toMatchObject({
      query: 'Jiandanly harness',
      search_depth: 'basic',
      include_answer: true,
      include_raw_content: false,
      max_results: 2,
    })
    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({ provider: 'tavily', results_count: 2 }),
    })
    expect(result.content).toContain('Harness docs')
    expect(result.content).toContain('https://example.com/harness')
  })

  it('reports web.search as disabled when Tavily is not configured', async () => {
    const result = await executeTool({ id: 'call-search-disabled', name: 'web.search', arguments: { query: 'anything' } }, run)

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'web_search_disabled',
      recoverable: true,
    })
  })
})
