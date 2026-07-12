/* Dev-only WEB demo. NOT shipped. Renders the REAL <App/> against a mocked
 * cloud backend so the actual web build can be calibrated in a browser without
 * the Go API. A successful /api/v1/auth/refresh skips the login wall; the other
 * startup endpoints return canned data. IndexedDB is pre-seeded with a few
 * conversations so the sidebar + chat render with content.
 *
 * Open via `npm run dev` → http://localhost:<port>/app-demo.html
 * The web build has no local daemon (isDesktop=false), so 技能/MCP/连接 are hidden
 * exactly as in production web — that is correct. Use the Electron build or the
 * component harness (harness.html) to calibrate the desktop-only surfaces.
 */
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import '../styles.css'
import { App } from '../App'
import { LocalConversationStore } from '../shared/local-data/localConversations'
import type { ChatMessage, Conversation } from '../shared/local-data/types'

const USER = { id: 'u1', email: 'jimmy@shejane.com', name: 'Jimmy', role: 'user', status: 'active', email_verified: true }

// ── mock cloud backend (envelope: { code, message, data }; success = code 0) ──
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const balance = {
  id: 'w1', plan_code: 'payg', monthly_credit_limit: 0, monthly_credits_used: 0,
  monthly_remaining: 0, extra_credits_balance: 35190,
  period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(), status: 'active',
}

const models = [
  { id: 'deepseek-pro', label: 'DeepSeek Pro', description: '深度推理，适合复杂任务', priority: 1, input_price_per_million_cny: 4, output_price_per_million_cny: 16, cached_input_price_per_million_cny: 2, cache_write_price_per_million_cny: 4 },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', description: '快速回答，适合简单任务', priority: 2, input_price_per_million_cny: 1, output_price_per_million_cny: 2, cached_input_price_per_million_cny: 1, cache_write_price_per_million_cny: 1 },
]

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes('/api/v1/auth/refresh')) return ok({ access_token: 'demo-token', user: USER })
  if (url.includes('/api/v1/auth/logout')) return ok(null)
  if (url.includes('/api/v1/billing/balance')) return ok(balance)
  if (url.includes('/api/v1/billing/transactions')) return ok([])
  if (url.endsWith('/api/v1/models')) return ok({ models })
  if (url.includes('/api/v1/agent/tool-capabilities')) return ok({ tools: {} })
  if (url.endsWith('/api/v1/documents')) return ok([])
  // Any other cloud call: succeed emptily so the UI never wedges on a 404.
  if (url.includes('/api/v1/')) return ok(null)
  // Everything else (vite modules, assets, HMR) goes to the real network.
  return realFetch(input, init)
}) as typeof fetch

// ── seed IndexedDB so the sidebar + chat have content ─────────────────────────
const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const msg = (id: string, role: ChatMessage['role'], content: string, atMs: number): ChatMessage => ({
  id, role, content, createdAt: iso(atMs), status: 'done',
})

const richReply = `整理好了。下面是 Q2 的对数与 8 页骨架。

| 月份 | 营收 | 同比 |
| --- | --- | --- |
| 4 月 | 512 | +3.2% |
| 5 月 | 589 | -3.8% |
| 6 月 | 639 | +8.5% |

**汇报骨架（8 页）**

1. 结论先行：超额完成，完成率 97%
2. 中台迁移单独一页：进展 70%、灰度零事故
3. 风险与资源：2 个接口未适配，需要数据组两周

> 老板要求 ≤15 分钟，讲稿按 9 分钟设计，留足问答。

需要我把封面也配一版吗？`

const conversations: Conversation[] = [
  {
    id: 'c-active', title: '季度汇报准备', archived: false,
    createdAt: iso(now - 2 * HOUR), updatedAt: iso(now - 5 * 60_000),
    messages: [
      msg('m1', 'user', '帮我把 Q2 的营收数据整理成汇报，老板要看完成率和趋势。', now - 90 * 60_000),
      msg('m2', 'assistant', richReply, now - 88 * 60_000),
      msg('m3', 'user', '很好。汇总这件事以后每个月都要做，帮我写一个能自己跑的脚本。', now - 6 * 60_000),
      msg('m4', 'assistant', '可以。我会写一个按月拉取数据、生成同样表格与骨架的脚本，跑完直接产出 pptx。先确认数据源是在线表格还是导出的 xlsx？', now - 5 * 60_000),
    ],
  },
  { id: 'c2', title: '整理本周周报', archived: false, createdAt: iso(now - 3 * HOUR), updatedAt: iso(now - 40 * 60_000), messages: [] },
  { id: 'c3', title: '会议纪要：产品评审', archived: false, createdAt: iso(now - DAY), updatedAt: iso(now - DAY - HOUR), messages: [] },
  { id: 'c4', title: '出差报销流程咨询', archived: false, createdAt: iso(now - 4 * DAY), updatedAt: iso(now - 4 * DAY), messages: [] },
  { id: 'c5', title: '竞品功能对比表', archived: false, createdAt: iso(now - 8 * DAY), updatedAt: iso(now - 8 * DAY), messages: [] },
  { id: 'c-pin', title: '常用：日报模板', archived: false, pinned: true, createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 2 * HOUR), messages: [] },
]

// Surface any boot error on screen so a blank page is never silent.
function showError(label: string, err: unknown) {
  const box = document.createElement('pre')
  box.style.cssText = 'position:fixed;inset:12px;z-index:99999;margin:0;padding:14px;overflow:auto;background:#2a1215;color:#ff8a80;font:12px/1.5 ui-monospace,monospace;border-radius:8px;white-space:pre-wrap'
  box.textContent = `[${label}] ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`
  document.body.appendChild(box)
}
window.addEventListener('error', (e) => showError('error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showError('promise', e.reason))

const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function seed() {
  const store = new LocalConversationStore(`shejane-local:${USER.id}`)
  // Single transaction (importAll) rather than 6 sequential ones — more robust.
  await store.importAll({ version: 1, exportedAt: new Date().toISOString(), conversations })
}

async function boot() {
  // Best-effort seed, but never let an IndexedDB hang block the render.
  try {
    await Promise.race([seed(), timeout(6000)])
  } catch (err) {
    showError('seed', err)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // Convenience: open the conversation that actually has messages so
  // calibration lands in a populated chat rather than the empty welcome screen.
  const tryOpen = (attempt = 0) => {
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.conversation'))
    const target = rows.find((r) => r.textContent?.includes('季度汇报准备'))
    if (target) target.click()
    else if (attempt < 25) setTimeout(() => tryOpen(attempt + 1), 150)
  }
  setTimeout(() => tryOpen(), 500)
}

void boot()
