import { defineConfig, devices } from '@playwright/test'

const clientPort = process.env.E2E_CLIENT_PORT ?? '55173'
const adminPort = process.env.E2E_ADMIN_PORT ?? '55174'
const clientURL = process.env.E2E_CLIENT_URL ?? `http://127.0.0.1:${clientPort}`
const adminURL = process.env.E2E_ADMIN_URL ?? `http://127.0.0.1:${adminPort}`

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: clientURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `pnpm dev --host 127.0.0.1 --port ${clientPort}`,
      cwd: '../../apps/desktop',
      url: clientURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm dev --host 127.0.0.1 --port ${adminPort}`,
      cwd: '../../apps/admin',
      url: adminURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
