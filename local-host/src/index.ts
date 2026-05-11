import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLocalHostServer } from './server.js'
import { SQLiteLocalHostStore } from './state/sqliteStore.js'
import { LocalCloudSessionManager } from './llm/cloudSession.js'

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
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown(): void {
  store.close()
  server.close(() => {
    process.exit(0)
  })
}
