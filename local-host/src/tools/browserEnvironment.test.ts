import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { browserSnapshotScript, executeTool } from './executor.js'
import type { LocalRun } from '../types.js'

const run: LocalRun = {
  id: 'run-browser-environment-test',
  goal: 'Observe the user environment safely.',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('browser and environment observation tools', () => {
  it('keeps the Playwright snapshot script free of Node/esbuild helper references', () => {
    const link = fakeElement({ tagName: 'A', innerText: 'Example Link', href: '/next' })
    const button = fakeElement({ tagName: 'BUTTON', innerText: 'Open' })
    const input = fakeElement({ tagName: 'INPUT', value: '', placeholder: 'Search', name: 'q' })
    const form = fakeElement({
      tagName: 'FORM',
      action: '/search',
      fields: [input],
    })
    const result = runInNewContext(browserSnapshotScript, {
      URL,
      document: {
        title: 'Example Page',
        body: { innerText: 'Example Page Visible Text' },
        querySelectorAll: (selector: string) => {
          if (selector === 'a[href]') return [link]
          if (selector === 'form') return [form]
          if (selector === 'button, input[type="submit"], input[type="button"]') return [button]
          if (selector === 'a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]') return [link, button, input]
          return []
        },
      },
      location: { href: 'https://example.com/report' },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    })

    expect(browserSnapshotScript).not.toContain('__name')
    expect(result).toMatchObject({
      title: 'Example Page',
      url: 'https://example.com/report',
      visibleText: 'Example Page Visible Text',
      links: [{ text: 'Example Link', url: 'https://example.com/next' }],
      buttons: ['Open'],
      elements: expect.arrayContaining([expect.objectContaining({ ref: 'el-1', role: 'link', name: 'Example Link' })]),
    })
  })

  it('opens and snapshots a managed browser page through the safe fetch adapter', async () => {
    let requested = false
    const options = {
      browserEngine: 'fetch',
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

  it('allows proxy fake-ip DNS answers by default so managed browser search works behind local TUN proxies', async () => {
    let requested = false
    const result = await executeTool(
      { id: 'open-fake-ip-browser', name: 'browser.open', arguments: { url: 'https://example.com/report' } },
      run,
      {
        browserEngine: 'fetch',
        resolveHostname: async () => ['198.18.1.71'],
        fetcher: async () => {
          requested = true
          return new Response('<html><head><title>Via Proxy</title></head><body>ok</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        },
      },
    )

    expect(requested).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'browser.open', title: 'Via Proxy' }),
    })
  })

  it('can still block proxy fake-ip DNS answers when the guard is explicitly strict', async () => {
    let requested = false
    const result = await executeTool(
      { id: 'open-strict-fake-ip-browser', name: 'browser.open', arguments: { url: 'https://example.com/report' } },
      run,
      {
        allowProxyFakeIPs: false,
        resolveHostname: async () => ['198.18.1.71'],
        fetcher: async () => {
          requested = true
          return new Response('should not fetch')
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

  it('returns a recoverable error when browser.read is requested before a managed page exists', async () => {
    await expect(executeTool({ id: 'read-empty', name: 'browser.read', arguments: {} }, run, {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'browser_page_required',
      recoverable: true,
    })
  })

  it('reads the current managed browser page with source metadata and observation status', async () => {
    const snapshot = {
      url: 'https://example.com/report',
      title: 'Example Research Report',
      description: 'A short report description.',
      visibleText: 'Example Research Report\nThis report explains the source evidence.\nFooter',
      links: [
        { text: 'Primary source', url: 'https://example.com/source' },
        { text: 'Contact', url: 'https://example.com/contact' },
      ],
      forms: [],
      buttons: [],
      elements: [],
    }
    const result = await executeTool(
      { id: 'read-browser', name: 'browser.read', arguments: { maxTextCharacters: 128 } },
      run,
      {
        browser: {
          open: async () => snapshot,
          search: async () => snapshot,
          snapshot: async () => snapshot,
          screenshot: async () => ({ content: 'png', contentType: 'image/png', bytes: 3, title: 'screenshot' }),
          click: async () => snapshot,
          type: async () => snapshot,
          scroll: async () => snapshot,
          close: async () => undefined,
        },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        source: 'browser.read',
        url: 'https://example.com/report',
        title: 'Example Research Report',
        description: 'A short report description.',
        observation_status: 'usable',
        text_characters: snapshot.visibleText.length,
      }),
    })
    expect(JSON.parse(result.content)).toMatchObject({
      title: 'Example Research Report',
      url: 'https://example.com/report',
      description: 'A short report description.',
      observation_status: 'usable',
      main_text: expect.stringContaining('source evidence'),
      links: expect.arrayContaining([{ text: 'Primary source', url: 'https://example.com/source' }]),
    })
  })

  it('blocks the third duplicate browser search and open attempt within one run', async () => {
    let searches = 0
    let opens = 0
    const snapshot = {
      url: 'https://example.com/search?q=jiandanly',
      title: 'Search Results',
      visibleText: 'Jiandanly result page',
      links: [],
      forms: [],
      buttons: [],
      elements: [],
    }
    const options = {
      resolveHostname: async () => ['93.184.216.34'],
      browser: {
        open: async () => {
          opens += 1
          return { ...snapshot, url: 'https://example.com/report', title: 'Report' }
        },
        search: async () => {
          searches += 1
          return snapshot
        },
        snapshot: async () => snapshot,
        screenshot: async () => ({ content: 'png', contentType: 'image/png', bytes: 3, title: 'screenshot' }),
        click: async () => snapshot,
        type: async () => snapshot,
        scroll: async () => snapshot,
        close: async () => undefined,
      },
    } as any

    await expect(executeTool({ id: 'search-1', name: 'browser.search', arguments: { query: 'Jiandanly' } }, run, options)).resolves.toMatchObject({ ok: true })
    await expect(executeTool({ id: 'search-2', name: 'browser.search', arguments: { query: ' jiandanly ' } }, run, options)).resolves.toMatchObject({ ok: true })
    await expect(executeTool({ id: 'search-3', name: 'browser.search', arguments: { query: 'JIANDANLY' } }, run, options)).resolves.toMatchObject({
      ok: false,
      errorCode: 'browser_duplicate_observation',
      recoverable: true,
      data: expect.objectContaining({ observation_status: 'blocked' }),
    })

    await expect(executeTool({ id: 'open-1', name: 'browser.open', arguments: { url: 'https://example.com/report' } }, run, options)).resolves.toMatchObject({ ok: true })
    await expect(executeTool({ id: 'open-2', name: 'browser.open', arguments: { url: 'https://example.com/report/' } }, run, options)).resolves.toMatchObject({ ok: true })
    await expect(executeTool({ id: 'open-3', name: 'browser.open', arguments: { url: 'https://example.com/report' } }, run, options)).resolves.toMatchObject({
      ok: false,
      errorCode: 'browser_duplicate_observation',
      recoverable: true,
      data: expect.objectContaining({ observation_status: 'blocked' }),
    })
    expect(searches).toBe(2)
    expect(opens).toBe(2)
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

  it('executes managed browser search, screenshot, click, type, and scroll through the adapter', async () => {
    const calls: string[] = []
    const snapshot = {
      url: 'https://example.com/search?q=jiandanly',
      title: 'Search Results',
      visibleText: 'Jiandanly result page',
      links: [{ text: 'Jiandanly', url: 'https://example.com/result' }],
      forms: [{ action: 'https://example.com/search', fields: ['q'] }],
      buttons: ['Search'],
      elements: [{ ref: 'link-1', role: 'link', name: 'Jiandanly', text: 'Jiandanly', href: 'https://example.com/result' }],
    }
    const browser = {
      open: async () => snapshot,
      search: async ({ query }: { query: string }) => {
        calls.push(`search:${query}`)
        return snapshot
      },
      snapshot: async () => snapshot,
      screenshot: async () => {
        calls.push('screenshot')
        return { content: 'base64-png', contentType: 'image/png', bytes: 10, title: 'Search Results screenshot' }
      },
      click: async ({ ref }: { ref: string }) => {
        calls.push(`click:${ref}`)
        return { ...snapshot, url: 'https://example.com/result', title: 'Jiandanly' }
      },
      type: async ({ ref, text }: { ref: string; text: string }) => {
        calls.push(`type:${ref}:${text}`)
        return snapshot
      },
      scroll: async ({ direction }: { direction: string }) => {
        calls.push(`scroll:${direction}`)
        return snapshot
      },
      close: async () => undefined,
    }
    const options = { browser, resolveHostname: async () => ['204.79.197.200'] } as any

    const searched = await executeTool({ id: 'search-browser', name: 'browser.search', arguments: { query: 'jiandanly' } }, run, options)
    expect(searched).toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'browser.search', title: 'Search Results' }),
    })
    expect(JSON.parse(searched.content).elements).toEqual([expect.objectContaining({ ref: 'link-1', role: 'link' })])

    const screenshot = await executeTool({ id: 'screenshot-browser', name: 'browser.screenshot', arguments: {} }, run, options)
    expect(screenshot.content).toContain('Screenshot captured')
    expect((screenshot as any).artifact).toMatchObject({
      content: 'base64-png',
      contentType: 'image/png',
      title: 'Search Results screenshot',
    })

    await expect(executeTool({ id: 'click-browser', name: 'browser.click', arguments: { ref: 'link-1' } }, run, options)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'browser.click', url: 'https://example.com/result' }),
    })
    await expect(executeTool({ id: 'type-browser', name: 'browser.type', arguments: { ref: 'q', text: 'hello' } }, run, options)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'browser.type' }),
    })
    await expect(executeTool({ id: 'scroll-browser', name: 'browser.scroll', arguments: { direction: 'down' } }, run, options)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining({ source: 'browser.scroll' }),
    })

    expect(calls).toEqual(['search:jiandanly', 'screenshot', 'click:link-1', 'type:q:hello', 'scroll:down'])
  })

  it('treats managed browser HTTP error pages as recoverable tool failures', async () => {
    const snapshot = {
      url: 'https://example.com/missing',
      title: '404 Not Found',
      visibleText: '404 Not Found',
      httpStatus: 404,
      links: [],
      forms: [],
      buttons: [],
      elements: [],
    }
    const browser = {
      open: async () => snapshot,
      search: async () => snapshot,
      snapshot: async () => snapshot,
      screenshot: async () => ({ content: 'base64-png', contentType: 'image/png', bytes: 10, title: '404 screenshot' }),
      click: async () => snapshot,
      type: async () => snapshot,
      scroll: async () => snapshot,
      close: async () => undefined,
    }

    await expect(
      executeTool(
        { id: 'open-missing-browser', name: 'browser.open', arguments: { url: 'https://example.com/missing' } },
        run,
        { browser, resolveHostname: async () => ['93.184.216.34'] } as any,
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'browser_http_error',
      recoverable: true,
      data: expect.objectContaining({
        source: 'browser.open',
        http_status: 404,
        title: '404 Not Found',
      }),
    })
  })
})

function fakeElement(input: {
  tagName: string
  innerText?: string
  textContent?: string
  value?: string
  placeholder?: string
  href?: string
  action?: string
  name?: string
  fields?: Array<ReturnType<typeof fakeElement>>
}): Record<string, unknown> {
  const attributes = new Map<string, string>()
  if (input.href) attributes.set('href', input.href)
  if (input.action) attributes.set('action', input.action)
  if (input.name) attributes.set('name', input.name)
  return {
    tagName: input.tagName,
    innerText: input.innerText,
    textContent: input.textContent ?? input.innerText,
    value: input.value,
    placeholder: input.placeholder,
    getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, left: 0 }),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    querySelectorAll: (selector: string) => (selector === 'input[name], textarea[name], select[name]' ? input.fields ?? [] : []),
  }
}
