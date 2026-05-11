import { expect, test } from '@playwright/test'
import { adminURL, installAdminMocks, requestWasMade } from './helpers'

test.describe('admin simulated operations flows', () => {
  test('switches operational tabs and keeps orders/providers read-only', async ({ page }) => {
    await installAdminMocks(page, 'admin')

    await page.goto(adminURL)
    await page.getByLabel('邮箱').fill('admin@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '登录' }).click()

    await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible()
    await expect(page.getByText('运营概览')).toBeVisible()

    await page.getByRole('tab', { name: '订单' }).click()
    await expect(page.getByText(/order_1/)).toBeVisible()
    await expect(page.getByText(/sub_test_123/)).toBeVisible()
    await expect(page.getByRole('button', { name: /修改|退款|补单|删除/ })).toHaveCount(0)

    await page.getByRole('tab', { name: '模型' }).click()
    await expect(page.getByText(/deepseek-v4-flash/)).toBeVisible()
    await expect(page.getByText(/https:\/\/api\.deepseek\.com/)).toBeVisible()
    await expect(page.getByText(/secret|sk-|API_KEY|token/i)).toHaveCount(0)

    await page.getByRole('tab', { name: 'Agent' }).click()
    await expect(page.getByText(/run_1/)).toBeVisible()
    await expect(page.getByText('用户任务（18 字）')).toBeVisible()
    await expect(page.getByRole('button', { name: /取消|重试|删除/ })).toHaveCount(0)
  })

  test('validates credit adjustment reason before calling admin write APIs', async ({ page }) => {
    const state = await installAdminMocks(page, 'admin')

    await page.goto(adminURL)
    await page.getByLabel('邮箱').fill('admin@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByText('运营概览')).toBeVisible()

    await page.getByRole('tab', { name: '用户' }).click()
    await page.getByRole('button', { name: '调整额度' }).click()
    await expect(page.getByText('额度调整不能为 0')).toBeVisible()

    await page.getByPlaceholder('额外额度调整，例如 1000 或 -500').fill('100')
    await page.getByRole('button', { name: '调整额度' }).click()
    await expect(page.getByText('请填写操作原因')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/admin/users/admin-1/credits/adjust')).toBe(false)

    await page.getByPlaceholder('操作原因').fill('manual grant')
    await page.getByRole('button', { name: '调整额度' }).click()
    await expect(page.getByText('额外额度已调整')).toBeVisible()
    expect(requestWasMade(state, '/api/v1/admin/users/admin-1/credits/adjust')).toBe(true)
  })

  test('blocks non-admin users before loading admin data', async ({ page }) => {
    const state = await installAdminMocks(page, 'user')

    await page.goto(adminURL)
    await page.getByLabel('邮箱').fill('user@example.com')
    await page.getByLabel('密码').fill('secret123')
    await page.getByRole('button', { name: '登录' }).click()

    await expect(page.getByText('无管理员权限')).toBeVisible()
    expect(state.requests.some((request) => request.url.includes('/api/v1/admin/'))).toBe(false)
  })
})
