import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { ChatMessage } from '@/shared/local-data/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '今天杭州多云。',
    createdAt: new Date().toISOString(),
    status: 'done',
    ...overrides,
  }
}

describe('MessageBubble meta', () => {
  it('renders Markdown live while streaming (no raw ** flash)', () => {
    vi.useFakeTimers()
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'streaming', content: '**你好**' })} />
      </I18nProvider>,
    )

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(container.querySelector('strong')?.textContent).toBe('你好')
    expect(screen.queryByText('**你好**')).not.toBeInTheDocument()
  })

  it('treats a single newline as a line break (remark-breaks)', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'done', content: '第一行\n第二行' })} />
      </I18nProvider>,
    )
    expect(container.querySelector('br')).toBeInTheDocument()
    const paragraphText = container.querySelector('p')?.textContent ?? ''
    expect(paragraphText).toContain('第一行')
    expect(paragraphText).toContain('第二行')
  })

  it('normalizes ad-hoc heading levels on the finished message', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', status: 'done', content: '### 标题\n正文' })} />
      </I18nProvider>,
    )
    // remark-normalize-headings (finished path) rebalances a lone `###` to h1.
    expect(container.querySelector('h1')?.textContent).toBe('标题')
    expect(container.querySelector('h3')).not.toBeInTheDocument()
  })

  it('shows the relative time and copies the message content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <MessageBubble message={message()} />
      </I18nProvider>,
    )

    expect(screen.getByText('刚刚')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('今天杭州多云。')
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument())
  })

  it('also lets the user message be copied', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'user', content: '杭州天气怎么样' })} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('杭州天气怎么样')
  })

  it('omits the copy action when there is no content', () => {
    render(
      <I18nProvider>
        <MessageBubble message={message({ content: '' })} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument()
    expect(screen.getByText('刚刚')).toBeInTheDocument()
  })

  it('renders recognized office filenames as preview buttons that fire with the resolved absolute path', () => {
    const onPreviewLocalFile = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            content: 'Files in workspace:\n- report.docx\n- /tmp/numbers.xlsx\n- notes.txt',
          })}
          workspaceRoot="/Users/me/proj"
          onPreviewLocalFile={onPreviewLocalFile}
        />
      </I18nProvider>,
    )

    // Relative path → resolved against workspaceRoot.
    const reportBtn = screen.getByRole('button', { name: 'report.docx' })
    fireEvent.click(reportBtn)
    expect(onPreviewLocalFile).toHaveBeenLastCalledWith({
      path: '/Users/me/proj/report.docx',
      kind: 'word',
      name: 'report.docx',
    })

    // Absolute path → passes through as-is.
    const numbersBtn = screen.getByRole('button', { name: '/tmp/numbers.xlsx' })
    fireEvent.click(numbersBtn)
    expect(onPreviewLocalFile).toHaveBeenLastCalledWith({
      path: '/tmp/numbers.xlsx',
      kind: 'excel',
      name: 'numbers.xlsx',
    })

    // Non-office filename stays plain text — no button for "notes.txt".
    expect(screen.queryByRole('button', { name: 'notes.txt' })).not.toBeInTheDocument()
  })

  it('finds office filenames wrapped in inline code + bold (regression: the agent emits **`X.docx`**)', () => {
    const onPreviewLocalFile = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            // This is exactly the markdown the agent emits for a docx
            // listing — bold + inline code, inside a numbered list.
            content: '当前目录下有 3 个 doc 文件：\n\n1. **`副本软件开发合同模板.docx`**\n2. **`灵活就业登记.docx`**\n3. **`软件开发合同模板.docx`**',
          })}
          workspaceRoot="/Users/me/Downloads/合同"
          onPreviewLocalFile={onPreviewLocalFile}
        />
      </I18nProvider>,
    )

    const firstBtn = screen.getByRole('button', { name: '副本软件开发合同模板.docx' })
    fireEvent.click(firstBtn)
    expect(onPreviewLocalFile).toHaveBeenLastCalledWith({
      path: '/Users/me/Downloads/合同/副本软件开发合同模板.docx',
      kind: 'word',
      name: '副本软件开发合同模板.docx',
    })

    expect(screen.getByRole('button', { name: '灵活就业登记.docx' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '软件开发合同模板.docx' })).toBeInTheDocument()
  })

  it('skips office-link rendering when onPreviewLocalFile is not provided', () => {
    render(
      <I18nProvider>
        <MessageBubble message={message({ content: 'See report.docx' })} workspaceRoot="/x/y" />
      </I18nProvider>,
    )
    // Without a callback, the filename stays plain text — no button.
    expect(screen.queryByRole('button', { name: 'report.docx' })).not.toBeInTheDocument()
    // The text itself is still visible.
    expect(screen.getByText(/See report\.docx/)).toBeInTheDocument()
  })

  it('renders office-type attachment chips as clickable buttons that fire onPreviewCloudAttachment', () => {
    const onPreviewCloudAttachment = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            role: 'user',
            content: '看下这个',
            attachments: [
              {
                documentId: 'doc_1',
                name: 'spec.docx',
                contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              },
              {
                documentId: 'doc_2',
                name: 'notes.txt',
                contentType: 'text/plain',
              },
            ],
          })}
          onPreviewCloudAttachment={onPreviewCloudAttachment}
        />
      </I18nProvider>,
    )

    // .docx chip → clickable button.
    const docxChip = screen.getByRole('button', { name: /spec\.docx/ })
    fireEvent.click(docxChip)
    expect(onPreviewCloudAttachment).toHaveBeenCalledWith({
      documentId: 'doc_1',
      kind: 'word',
      name: 'spec.docx',
    })

    // .txt chip → NOT a button (we don't preview plain text via the panel).
    expect(screen.queryByRole('button', { name: /notes\.txt/ })).not.toBeInTheDocument()
    expect(screen.getByText(/notes\.txt/)).toBeInTheDocument()
  })
})
