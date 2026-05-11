import { describe, expect, it } from 'vitest'
import { executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

const run: LocalRun = {
  id: 'run-browser-environment-test',
  goal: 'Observe the user environment safely.',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('browser and environment observation tools', () => {
  it('opens and snapshots a managed browser page through the safe fetch adapter', async () => {
    let requested = false
    const options = {
      resolveHostname: async () => ['93.184.216.34'],
      fetcher: async () => {
        requested = true
        return new Response(
          [
            '<html>',
            '<head><title>Example Report</title><script>ignore()</script></head>',
            '<body>',
            '<h1>Quarterly Report</h1>',
            '<a href="/source">Source Link</a>',
            '<form action="/submit"><input name="email" /><button>Send</button></form>',
            '<button>Download</button>',
            '</body>',
            '</html>',
          ].join(''),
          {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        )
      },
    }

    const opened = await executeTool({ id: 'open-browser', name: 'browser.open', arguments: { url: 'https://example.com/report' } }, run, options)
    expect(requested).toBe(true)
    expect(opened).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        source: 'browser.open',
        url: 'https://example.com/report',
        title: 'Example Report',
        links_count: 1,
        forms_count: 1,
        buttons_count: 2,
      }),
    })

    const snapshot = await executeTool({ id: 'snapshot-browser', name: 'browser.snapshot', arguments: { maxTextCharacters: 32 } }, run, options)
    const body = JSON.parse(snapshot.content)
    expect(snapshot).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        source: 'browser.snapshot',
        url: 'https://example.com/report',
        title: 'Example Report',
      }),
    })
    expect(body.visible_text).toBe('Example Report Quarterly Report')
    expect(body.links).toEqual([{ text: 'Source Link', url: 'https://example.com/source' }])
    expect(body.forms).toEqual([{ action: 'https://example.com/submit', fields: ['email'] }])
    expect(body.buttons).toEqual(['Send', 'Download'])
  })

  it('blocks private-network browser.open targets before making a request', async () => {
    let requested = false
    const result = await executeTool(
      { id: 'open-private-browser', name: 'browser.open', arguments: { url: 'http://metadata.local/secret' } },
      run,
      {
        resolveHostname: async () => ['127.0.0.1'],
        fetcher: async () => {
          requested = true
          return new Response('private')
        },
      },
    )

    expect(requested).toBe(false)
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ssrf_blocked',
      recoverable: true,
    })
  })

  it('returns a recoverable error when snapshot is requested before browser.open', async () => {
    await expect(executeTool({ id: 'snapshot-empty', name: 'browser.snapshot', arguments: {} }, run, {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'browser_page_required',
      recoverable: true,
    })
  })

  it('observes environment through an injected adapter without adding private text to payload data', async () => {
    const result = await executeTool(
      { id: 'environment', name: 'environment.observe', arguments: {} },
      run,
      {
        environment: {
          observe: async () => ({
            platform: 'darwin',
            foregroundApp: 'Preview',
            windowTitle: 'Invoice.pdf',
            screenPermission: 'unknown',
          }),
        },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        source: 'environment.observe',
        platform: 'darwin',
        foreground_app: 'Preview',
        window_title: 'Invoice.pdf',
        screen_permission: 'unknown',
      },
    })
    expect(result.content).toBe('Platform: darwin\nForeground app: Preview\nWindow title: Invoice.pdf\nScreen permission: unknown')
  })
})
