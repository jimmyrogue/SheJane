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

  it('syntax-highlights a fenced code block', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', content: '```python\nprint("hi")\n```' })} />
      </I18nProvider>,
    )
    const block = container.querySelector('.code-block')
    expect(block).toBeInTheDocument()
    // highlight.js tokenized the body into colored spans.
    expect(container.querySelector('pre.code-block-pre code.hljs')).toBeInTheDocument()
    expect(container.querySelector('.code-block .hljs-string')).toBeInTheDocument()
  })

  it("copies only the raw code from a block's own copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', content: '说明:\n```js\nconst a = 1\n```' })} />
      </I18nProvider>,
    )

    // The block copy button has its own accessible name, distinct from the
    // message-level "复制" button (so the two never collide).
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制代码' })).toBeInTheDocument())
  })

  it('regenerates an assistant reply and offers no edit affordance', () => {
    const onRegenerate = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble message={message()} onRegenerate={onRegenerate} onEditResend={vi.fn()} />
      </I18nProvider>,
    )
    // Assistant messages get regenerate, not edit.
    expect(screen.queryByRole('button', { name: '编辑并重发' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    expect(onRegenerate).toHaveBeenCalledWith('m1')
  })

  it('edits and resends a user message', () => {
    const onEditResend = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'user', content: '原始问题' })} onEditResend={onEditResend} onRegenerate={vi.fn()} />
      </I18nProvider>,
    )
    // User messages get edit, not regenerate.
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑并重发' }))
    const textarea = screen.getByLabelText('编辑并重发')
    fireEvent.change(textarea, { target: { value: '修改后的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并重发' }))
    expect(onEditResend).toHaveBeenCalledWith('m1', '修改后的问题')
  })

  it('cancels an edit without resending', () => {
    const onEditResend = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'user', content: '原始问题' })} onEditResend={onEditResend} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑并重发' }))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onEditResend).not.toHaveBeenCalled()
    // Back to view mode: the textarea is gone, the edit button is back.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑并重发' })).toBeInTheDocument()
  })

  it('requests deletion of a message', () => {
    const onDelete = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble message={message()} onDelete={onDelete} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onDelete).toHaveBeenCalledWith('m1')
  })

  it('disables retry/edit/delete while a run is active', () => {
    const onRegenerate = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble message={message()} onRegenerate={onRegenerate} onDelete={vi.fn()} runActive />
      </I18nProvider>,
    )
    const regenerate = screen.getByRole('button', { name: '重新生成' })
    expect(regenerate).toBeDisabled()
    fireEvent.click(regenerate)
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
  })

  it('shows a per-turn usage chip on a settled assistant turn', () => {
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            tokens: 1234,
            creditsCost: 3,
            agentEvents: [{ type: 'tool.completed', label: 'ran' }],
          })}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('1.2k tokens · 3 积分 · 1 次工具')).toBeInTheDocument()
  })

  it('omits the usage chip when there is no usage data', () => {
    render(
      <I18nProvider>
        <MessageBubble message={message()} />
      </I18nProvider>,
    )
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
    expect(screen.queryByText(/积分/)).not.toBeInTheDocument()
  })

  it('keeps inline code as a plain chip with no copy button', () => {
    const { container } = render(
      <I18nProvider>
        <MessageBubble message={message({ role: 'assistant', content: '用 `npm install` 安装' })} />
      </I18nProvider>,
    )
    expect(container.querySelector('.code-block')).not.toBeInTheDocument()
    expect(container.querySelector('code')?.textContent).toBe('npm install')
    expect(screen.queryByRole('button', { name: '复制代码' })).not.toBeInTheDocument()
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

  it('renders PDF attachment chips as clickable previewable buttons (kind=pdf)', () => {
    // Regression: PDFs used to fall through to the non-clickable
    // path because previewableKindFromAttachment didn't know about
    // them. After Plan 1, PDF is a first-class previewable kind
    // routed to the side panel's PdfPreview.
    const onPreviewCloudAttachment = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            role: 'user',
            content: '',
            attachments: [
              {
                documentId: 'doc_pdf',
                name: 'paper.pdf',
                contentType: 'application/pdf',
              },
            ],
          })}
          onPreviewCloudAttachment={onPreviewCloudAttachment}
        />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button', { name: /paper\.pdf/ })
    fireEvent.click(chip)
    expect(onPreviewCloudAttachment).toHaveBeenCalledWith({
      documentId: 'doc_pdf',
      kind: 'pdf',
      name: 'paper.pdf',
    })
  })

  it('renders the external-open button when onOpenAttachmentExternally is provided', () => {
    const onOpenAttachmentExternally = vi.fn()
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            role: 'user',
            content: '',
            attachments: [
              {
                documentId: 'doc_x',
                name: 'archive.zip',
                contentType: 'application/zip',
              },
            ],
          })}
          onOpenAttachmentExternally={onOpenAttachmentExternally}
        />
      </I18nProvider>,
    )
    // The chip itself is NOT a button (.zip isn't previewable) but
    // the external-open button next to it IS, regardless of preview
    // support — that's the escape hatch we just added.
    const externalBtn = screen.getByRole('button', { name: '下载到本机' })
    fireEvent.click(externalBtn)
    expect(onOpenAttachmentExternally).toHaveBeenCalledWith({
      documentId: 'doc_x',
      name: 'archive.zip',
    })
  })

  it('hides the external-open button entirely when no handler is supplied', () => {
    render(
      <I18nProvider>
        <MessageBubble
          message={message({
            role: 'user',
            content: '',
            attachments: [
              { documentId: 'doc_x', name: 'something.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            ],
          })}
        />
      </I18nProvider>,
    )
    expect(screen.queryByRole('button', { name: '下载到本机' })).not.toBeInTheDocument()
  })
})
