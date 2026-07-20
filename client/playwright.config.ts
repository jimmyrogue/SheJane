import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  testDir: './e2e',
  timeout: process.env.SHEJANE_E2E_REAL_LLM_MODEL ? 180_000 : 45_000,
  expect: { timeout: process.env.SHEJANE_E2E_REAL_LLM_MODEL ? 120_000 : 10_000 },
  fullyParallel: false,
  workers: 1,
  // A retry can preserve diagnostics but would also make a flaky regression
  // exit green. Critical-path E2E therefore fails on the first attempt.
  retries: 0,
  reporter: [['line']],
  outputDir:
    process.env.SHEJANE_E2E_ARTIFACT_DIR ??
    path.join(os.tmpdir(), 'shejane-playwright-artifacts'),
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
