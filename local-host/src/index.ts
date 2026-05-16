import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLocalHostServer } from './server.js'
import { SQLiteLocalHostStore } from './state/sqliteStore.js'
import { LocalCloudSessionManager } from './llm/cloudSession.js'
import { localHostDebugEnabled } from './debugLogger.js'

const host = process.env.JIANDANLY_LOCAL_HOST_ADDR || '127.0.0.1'
const port = Number(process.env.JIANDANLY_LOCAL_HOST_PORT || '17371')
const pairingToken = process.env.JIANDANLY_LOCAL_HOST_TOKEN

if (!pairingToken) {
  throw new Error('JIANDANLY_LOCAL_HOST_TOKEN is required to start the Local Agent Harness host.')
}

const dbPath =
  process.env.JIANDANLY_LOCAL_HOST_DB ||
  join(homedir(), '.jiandanly', 'local-agent-harness', 'local-host.sqlite3')

const store = new SQLiteLocalHostStore(dbPath)
const cloudBaseURL = process.env.JIANDANLY_CLOUD_BASE_URL
const cloudAccessToken = process.env.JIANDANLY_CLOUD_ACCESS_TOKEN
const cloudSession = new LocalCloudSessionManager({ defaultBaseURL: cloudBaseURL })
if (cloudBaseURL && cloudAccessToken) {
  cloudSession.setSession({ cloudBaseURL, accessToken: cloudAccessToken })
}
const server = createLocalHostServer({ pairingToken, store, cloudSession })

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Jiandanly Local Agent Harness listening on http://${host}:${port}`)
  if (localHostDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(
      '[jiandanly:local-host]',
      'debug.enabled',
      JSON.stringify({
        browser_engine: process.env.JIANDANLY_BROWSER_ENGINE ?? 'playwright',
        browser_headless: process.env.JIANDANLY_BROWSER_HEADLESS ?? 'true',
        browser_timeout_ms: process.env.JIANDANLY_BROWSER_TIMEOUT_MS ?? '15000',
        browser_search_url: process.env.JIANDANLY_BROWSER_SEARCH_URL ?? 'https://cn.bing.com/search?q={query}',
        allow_proxy_fake_ips: process.env.JIANDANLY_ALLOW_PROXY_FAKE_IPS ?? 'true',
        local_max_steps: process.env.JIANDANLY_LOCAL_MAX_STEPS ?? 'unlimited',
        local_step_warning_interval: process.env.JIANDANLY_LOCAL_STEP_WARNING_INTERVAL ?? '20',
        local_input_guard: process.env.JIANDANLY_LOCAL_INPUT_GUARD ?? 'off',
        local_tool_retry: process.env.JIANDANLY_LOCAL_TOOL_RETRY ?? '0',
        local_tool_failure_limit: process.env.JIANDANLY_LOCAL_TOOL_FAILURE_LIMIT ?? '0',
        local_planning: process.env.JIANDANLY_LOCAL_PLANNING ?? 'off',
        local_planning_model: process.env.JIANDANLY_LOCAL_PLANNING_MODEL ?? 'fast',
        local_reflection: process.env.JIANDANLY_LOCAL_REFLECTION ?? 'off',
        local_reflection_model: process.env.JIANDANLY_LOCAL_REFLECTION_MODEL ?? 'fast',
        local_reflection_max_iters: process.env.JIANDANLY_LOCAL_REFLECTION_MAX_ITERS ?? '1',
        cloud_tool_gateway: cloudSession.state().connected ? 'session' : 'requires_login',
        cloud_base_url: cloudBaseURL ?? 'http://localhost:8080',
      }),
    )
  }
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown(): void {
  store.close()
  server.close(() => {
    process.exit(0)
  })
}
