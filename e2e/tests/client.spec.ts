import { expect, test } from '@playwright/test'
import { clientURL, installClientMocks, requestWasMade } from './helpers'

test.describe('client simulated user flows', () => {
  test('registers, sends a normal chat message, and hides admin entry', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码', { exact: true }).fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' })).toBeVisible()
    await expect(page.getByText('管理后台')).toHaveCount(0)

    await page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' }).fill('你好')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('普通回答')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs/run-chat/stream')).toBe(true)
    expect(requestWasMade(state, '/api/v1/chat/completions')).toBe(false)
  })

  test('asks an attached document through agent runs instead of the legacy document ask API', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码', { exact: true }).fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()
    await expect(page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' })).toBeVisible()

    // Attaching now means uploading (the pick-an-existing-document list was
    // removed) — drive the hidden file input directly.
    await page.getByLabel('上传附件', { exact: true }).setInputFiles({
      name: 'brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('hello'),
    })
    await expect(page.getByTitle(/brief\.docx/)).toBeVisible()
    await page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' }).fill('这份文档的结论是什么？')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('文档回答')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs/run-doc/stream')).toBe(true)
    expect(requestWasMade(state, '/api/v1/documents/doc-ready/ask')).toBe(false)
  })

  test('uploads a document from the unified composer', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码', { exact: true }).fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()
    await expect(page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' })).toBeVisible()

    // The attach tool now triggers the native file chooser directly (no
    // dialog) — drive the hidden file input programmatically instead of
    // clicking the button (which would block on an OS chooser).
    await page.getByLabel('上传附件', { exact: true }).setInputFiles({
      name: 'brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('hello'),
    })

    await expect(page.getByTitle(/brief\.docx/)).toBeVisible()
    expect(requestWasMade(state, '/api/v1/documents/uploads')).toBe(true)
    expect(requestWasMade(state, 'https://s3.example.com/upload')).toBe(true)
    await expect.poll(() => requestWasMade(state, '/api/v1/documents/doc-upload/complete')).toBe(true)
  })

  test('uses the paired Local Harness, approves permissions, and opens diagnostics', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true })

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码', { exact: true }).fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByLabel('本地服务已连接').first()).toBeVisible()
    // Binding a workspace now goes through the native folder picker (stubbed
    // in installClientMocks to return /tmp/picked-workspace) — no in-app
    // path-input dialog anymore.
    await page.getByRole('button', { name: '添加项目' }).click()
    await expect(page.getByText('picked-workspace').first()).toBeVisible()
    await page.getByRole('textbox', { name: '描述你的问题、任务，或让石间阅读附件' }).fill('运行本地检查')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('等待批准：运行命令').first()).toBeVisible()
    await page.getByRole('button', { name: '允许一次' }).click()

    await expect(page.getByText('本地执行完成')).toBeVisible()
    // The redesigned agent-progress row no longer dumps raw sources/artifacts
    // into the timeline (the per-artifact "查看 artifact" buttons + source-count
    // badge + inline "任务完成" status were removed) — they live only in the
    // diagnostics panel now. The timeline must stay free of raw source dumps.
    await expect(page.getByText('收集来源：Example Source')).toHaveCount(0)
    await expect(page.getByText('https://example.com/source')).toHaveCount(0)

    // Diagnostics is the run-result escape hatch: expand the agent-progress row,
    // then open the diagnostics panel via the single 诊断 entry.
    await page.getByRole('button', { name: '展开步骤' }).click()
    await page.getByTitle('查看诊断 local-run').click()
    await expect(page.getByText('任务诊断：local-run')).toBeVisible()
    await expect(page.getByText('verification.completed')).toBeVisible()
    await expect(page.locator('.diagnostics-preview').getByText(/https:\/\/example\.com\/source/)).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出当前诊断' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('shejane-local-run-local-run-diagnostics.json')
    await expect(page.getByText('诊断已导出：local-run')).toBeVisible()

    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    expect(requestWasMade(state, '/local/v1/permissions/perm-shell')).toBe(true)
    expect(requestWasMade(state, '/local/v1/runs/local-run/diagnostics')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(false)
  })

  test('hides recent local runs from the primary UI', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true, recentRun: true })

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码', { exact: true }).fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByText('Resume workspace scan')).toHaveCount(0)
    await expect(page.getByText('最近本地任务')).toHaveCount(0)
    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    expect(requestWasMade(state, '/local/v1/runs/recover-run/diagnostics')).toBe(false)
  })
})
