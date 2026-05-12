import { expect, test } from '@playwright/test'
import { clientURL, installClientMocks, requestWasMade } from './helpers'

test.describe('client simulated user flows', () => {
  test('registers, sends a normal chat message, and hides admin entry', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByText('user@example.com')).toBeVisible()
    await expect(page.getByText('管理后台')).toHaveCount(0)

    await page.getByPlaceholder('描述你的问题、任务，或让简单阅读附件').fill('你好')
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
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()
    await expect(page.getByText('user@example.com')).toBeVisible()

    await page.getByText('roadmap.pdf').click()
    await expect(page.getByText('已附加 roadmap.pdf')).toBeVisible()
    await page.getByPlaceholder('描述你的问题、任务，或让简单阅读附件').fill('这份文档的结论是什么？')
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
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()
    await expect(page.getByText('user@example.com')).toBeVisible()

    await page.getByLabel('上传附件').setInputFiles({
      name: 'brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('hello'),
    })

    await expect(page.getByText('已附加 brief.docx')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/documents/uploads')).toBe(true)
    expect(requestWasMade(state, 'https://s3.example.com/upload')).toBe(true)
    await expect.poll(() => requestWasMade(state, '/api/v1/documents/doc-upload/complete')).toBe(true)
  })

  test('uses the paired Local Harness, approves permissions, and opens artifacts', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true })

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByText('本地 Harness').first()).toBeVisible()
    await page.getByLabel('本地工作区路径').fill('/tmp/jiandanly-workspace')
    await page.getByPlaceholder('描述你的问题、任务，或让简单阅读附件').fill('运行本地检查')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('需要权限：运行命令').first()).toBeVisible()
    await page.getByRole('button', { name: '允许一次' }).click()

    await expect(page.getByText('本地执行完成')).toBeVisible()
    await expect(page.getByText('验证通过：运行命令')).toBeVisible()
    await page.getByRole('button', { name: '查看 artifact' }).click()
    await expect(page.getByText('Artifact: shell output')).toBeVisible()
    await expect(page.getByText('artifact preview content')).toBeVisible()

    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    expect(requestWasMade(state, '/local/v1/permissions/perm-shell')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(false)
  })

  test('recovers recent local runs and downloads redacted diagnostics', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true, recentRun: true })

    await page.goto(clientURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '创建账号' }).click()

    await expect(page.getByText('Resume workspace scan')).toBeVisible()
    await page.getByTitle('恢复 Resume workspace scan').click()
    await expect(page.getByText('恢复后的本地结果')).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByTitle('导出诊断 Resume workspace scan').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('jiandanly-local-run-recover-run-diagnostics.json')
    await expect(page.getByText('诊断已导出：recover-run')).toBeVisible()
    expect(requestWasMade(state, '/local/v1/runs/recover-run/diagnostics')).toBe(true)
  })
})
