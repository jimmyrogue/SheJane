import { expect, test, type Page } from '@playwright/test'
import { clientURL, installClientMocks, requestWasMade } from './helpers'

const composerLabel = '交给石间——描述任务，或拖入文件'

function composer(page: Page) {
  return page.getByRole('textbox', { name: composerLabel })
}

test.describe('standalone Desktop + Runtime flows', () => {
  test('welcome suggestion tiles prefill the composer without a cloud account', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true })

    await page.goto(clientURL)

    const input = composer(page)
    await expect(input).toBeVisible()
    await expect(input).toHaveText('')
    await page.getByRole('button', { name: /整理未读消息/ }).click()
    await expect(input).toHaveText(/我会粘贴一组未读消息/)
    expect(requestWasMade(state, '/api/v1/')).toBe(false)
  })

  test('uses the paired Runtime and submits a durable permission command', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true })

    await page.goto(clientURL)

    await expect(composer(page)).toBeVisible()
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
    expect(requestWasMade(state, '/api/v1/')).toBe(false)
  })

  test('hides recent Runtime runs from the primary UI', async ({ page }) => {
    const state = await installClientMocks(page, { localHost: true, recentRun: true })

    await page.goto(clientURL)

    await expect(page.getByText('Resume workspace scan')).toHaveCount(0)
    await expect(page.getByText('最近本地任务')).toHaveCount(0)
    expect(requestWasMade(state, '/local/v1/runs')).toBe(true)
    expect(requestWasMade(state, '/local/v1/runs/recover-run/diagnostics')).toBe(false)
    expect(requestWasMade(state, '/api/v1/')).toBe(false)
  })
})
