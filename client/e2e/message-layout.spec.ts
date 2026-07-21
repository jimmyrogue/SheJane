import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')

test('assistant actions do not overlap the next message', async ({ page }) => {
  await page.setContent(`
    <style>${styles}</style>
    <main class="messages" style="width: 900px; height: 600px">
      <article class="message assistant">
        <div class="message-bubble-inner">
          <div class="message-content"><p>上一条回答</p></div>
        </div>
        <div class="message-meta" style="opacity: 1">
          <button class="message-meta-action">复制</button>
          <button class="message-meta-action">重试</button>
          <button class="message-meta-action">删除</button>
          <span class="message-meta-usage">15,804 个 token</span>
          <span class="message-meta-dot">·</span>
          <span class="message-meta-time">2 小时前</span>
        </div>
      </article>
      <article class="message user">
        <div class="message-bubble-inner"><div class="message-content">下一条问题</div></div>
      </article>
    </main>
  `)

  const actions = await page.locator('.message-meta').boundingBox()
  const nextMessage = await page.locator('.message.user').boundingBox()

  expect(actions).not.toBeNull()
  expect(nextMessage).not.toBeNull()
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(nextMessage!.y)
})

test('subtask card keeps compact bottom and following progress spacing', async ({ page }) => {
  await page.setContent(`
    <style>${styles}</style>
    <main class="messages" style="width: 900px; height: 600px">
      <article class="message assistant">
        <div class="message-bubble-inner">
          <div class="message-content"><p>3 个子 agent 已并行启动</p></div>
          <div class="agent-progress-stages mt-4">
            <div class="tool-card agent-progress agent-progress-stage agent-progress-working agent-progress-tool-card">
              <div class="tool-card-header agent-progress-summary agent-progress-summary-static">
                <span class="name">派发子任务</span>
                <span class="agent-progress-target">3 个子任务进行中</span>
              </div>
              <ul class="agent-progress-tasks">
                <li class="agent-progress-task-item">子任务 1</li>
                <li class="agent-progress-task-item">子任务 2</li>
                <li class="agent-progress-task-item">子任务 3</li>
              </ul>
            </div>
          </div>
        </div>
        <div class="message-meta" style="opacity: 1"><span>1 分钟前</span></div>
      </article>
      <div class="thinking-indicator"><span>正在思考...</span></div>
    </main>
  `)

  const card = await page.locator('.agent-progress').boundingBox()
  const lastTask = await page.locator('.agent-progress-task-item').last().boundingBox()
  const meta = await page.locator('.message-meta').boundingBox()
  const thinking = await page.locator('.thinking-indicator').boundingBox()

  expect(card).not.toBeNull()
  expect(lastTask).not.toBeNull()
  expect(meta).not.toBeNull()
  expect(thinking).not.toBeNull()
  expect.soft(card!.y + card!.height - (lastTask!.y + lastTask!.height)).toBeGreaterThanOrEqual(6)
  expect.soft(thinking!.y - (meta!.y + meta!.height)).toBeLessThanOrEqual(20)
})
