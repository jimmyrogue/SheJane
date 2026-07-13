import { expect, test, type Page } from '@playwright/test'
import { clientURL, installClientMocks, requestWasMade } from './helpers'

const composerLabel = '交给石间——描述任务，或拖入文件'

async function registerUser(page: Page) {
  await page.getByLabel('名称').fill('Test User')
  await page.getByLabel('邮箱').fill('user@example.com')
  await page.getByLabel('密码', { exact: true }).fill('secret123')
  await page.getByRole('button', { name: '创建账号' }).click()
}

function composer(page: Page) {
  return page.getByRole('textbox', { name: composerLabel })
}

test.describe('client simulated user flows', () => {
  test('registers, sends a normal chat message, and hides admin entry', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await registerUser(page)

    await expect(composer(page)).toBeVisible()
    await expect(page.getByText('管理后台')).toHaveCount(0)

    await composer(page).fill('你好')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('普通回答')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs/run-chat/stream')).toBe(true)
    expect(requestWasMade(state, '/api/v1/chat/completions')).toBe(false)
  })

  test('welcome suggestion tiles prefill the composer', async ({ page }) => {
    await installClientMocks(page)

    await page.goto(clientURL)
    await registerUser(page)

    const input = composer(page)
    await expect(input).toBeVisible()
    await expect(input).toHaveText('') // starts empty (not a dead button)

    // Clicking a suggestion tile drops a concrete, ready-to-send prompt in.
    await page.getByRole('button', { name: /整理未读消息/ }).click()
    await expect(input).toHaveText(/我会粘贴一组未读消息/)
  })

  test('asks an attached document through agent runs instead of the legacy document ask API', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await registerUser(page)
    await expect(composer(page)).toBeVisible()

    // Attaching now means uploading (the pick-an-existing-document list was
    // removed) — drive the hidden file input directly.
    await page.getByLabel('上传附件', { exact: true }).setInputFiles({
      name: 'brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('hello'),
    })
    await expect(page.getByTitle(/brief\.docx/)).toBeVisible()
    await composer(page).fill('这份文档的结论是什么？')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('文档回答')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs/run-doc/stream')).toBe(true)
    expect(requestWasMade(state, '/api/v1/documents/doc-ready/ask')).toBe(false)
  })

  test('uploads a document from the unified composer', async ({ page }) => {
    const state = await installClientMocks(page)

    await page.goto(clientURL)
    await registerUser(page)
    await expect(composer(page)).toBeVisible()

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

  test('uses the paired Runtime and submits a durable permission command', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true })

    await page.goto(clientURL)

    await expect(composer(page)).toBeVisible()
    // Binding a workspace now goes through the native folder picker (stubbed
    // in installClientMocks to return /tmp/picked-workspace) — no in-app
    // path-input dialog anymore.
    await page.getByRole('button', { name: '添加项目' }).click()
    await expect(page.getByLabel('项目已锁定：picked-workspace（新建对话可换）')).toBeVisible()
    await composer(page).fill('运行本地检查')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('等待批准：运行命令').first()).toBeVisible()
    await page.getByRole('button', { name: '允许一次' }).click()

    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    await expect.poll(() => state.requests.some((request) => {
      if (!request.url.endsWith('/local/v1/commands')) return false
      return (JSON.parse(request.body ?? '{}') as { type?: string }).type === 'permission.resolve'
    })).toBe(true)
    expect(requestWasMade(state, '/api/v1/agent/runs')).toBe(false)
  })

  test('hides recent local runs from the primary UI', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true, recentRun: true })

    await page.goto(clientURL)

    await expect(page.getByText('Resume workspace scan')).toHaveCount(0)
    await expect(page.getByText('最近本地任务')).toHaveCount(0)
    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    expect(requestWasMade(state, '/local/v1/runs/recover-run/diagnostics')).toBe(false)
  })
})
