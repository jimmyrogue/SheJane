import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, createTranslator } from '@/shared/i18n/i18n'
import { Composer, formatDocumentExpiry, type AttachmentDocument } from './Composer'
import { skillToken } from '../skillDraft'
import type { InstalledSkill } from '@/shared/local-host/client'

afterEach(cleanup)

const sampleSkills: InstalledSkill[] = [
  { name: 'hunt', description: 'Diagnose before you fix', path: '/s/hunt/SKILL.md' },
  { name: 'write', description: 'Strip AI writing patterns', path: '/s/write/SKILL.md' },
]

function documentFixture(id: string, name: string, contentType: string): AttachmentDocument {
  return {
    id,
    user_id: 'user-1',
    original_name: name,
    content_type: contentType,
    size_bytes: 128,
    status: 'ready',
    source_object_key: `documents/user/${id}/source`,
    text_object_key: `documents/user/${id}/text`,
    expires_at: '2026-05-28T12:00:00Z',
    created_at: '2026-05-26T12:00:00Z',
    updated_at: '2026-05-26T12:00:00Z',
  }
}

function Harness({
  initialDraft = '',
  onSend = vi.fn(),
  onAppendInstruction,
  listSkills = vi.fn().mockResolvedValue(sampleSkills),
  onDraft = vi.fn(),
  projectName,
  onSelectProject,
}: {
  initialDraft?: string
  onSend?: () => void
  onAppendInstruction?: () => void
  listSkills?: () => Promise<InstalledSkill[]>
  onDraft?: (value: string) => void
  projectName?: string
  onSelectProject?: () => void
}) {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <I18nProvider>
      <Composer
        draft={draft}
        onDraftChange={(value) => {
          onDraft(value)
          setDraft(value)
        }}
        isSending={false}
        isUploading={false}
        onUploadDocument={vi.fn()}
        onDetachDocument={vi.fn()}
        onSend={onSend}
        onAppendInstruction={onAppendInstruction}
        listSkills={listSkills}
        mode="auto"
        onModeChange={vi.fn()}
        projectName={projectName}
        onSelectProject={onSelectProject}
      />
    </I18nProvider>
  )
}

describe('Composer (Lexical skill editor)', () => {
  it('renders the editor with a placeholder when empty', () => {
    render(<Harness />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByText('交给石间——描述任务，或拖入文件')).toBeInTheDocument()
  })

  it('renders an inline skill pill for a draft that contains a skill token', async () => {
    render(<Harness initialDraft={`fix ${skillToken('hunt')} now`} />)
    const pill = await screen.findByText('hunt')
    expect(pill.closest('.skill-chip--inline')).not.toBeNull()
    // No border / icon / remove button — just styled inline text.
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
  })

  it('sends with plain Enter', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('still sends with Cmd/Ctrl+Enter for muscle-memory compatibility', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('inserts a newline on Shift+Enter instead of sending', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows "添加项目" button when no project is bound, fires onSelectProject on click', () => {
    const onSelectProject = vi.fn()
    render(<Harness onSelectProject={onSelectProject} />)
    const button = screen.getByRole('button', { name: '添加项目' })
    fireEvent.click(button)
    expect(onSelectProject).toHaveBeenCalledTimes(1)
  })

  it('locks into a project chip (non-button) when a project is bound', () => {
    const onSelectProject = vi.fn()
    render(<Harness projectName="客户A" onSelectProject={onSelectProject} />)
    // Project name is visible on the chip…
    expect(screen.getByText('客户A')).toBeInTheDocument()
    // …and the "添加项目" affordance is gone.
    expect(screen.queryByRole('button', { name: '添加项目' })).not.toBeInTheDocument()
  })

  // Regression: the stop button used to disappear the moment the
  // send promise resolved, which happens early when an SSE stream
  // blocks at a HITL permission card. Users were stranded with no
  // way to cancel a run paused for approval. The fix routes the
  // stop visibility off `isSending || hasActiveRun`.
  it('shows the stop button when a run is still active even if isSending is false', () => {
    const onStop = vi.fn()
    render(
      <I18nProvider>
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          isSending={false}
          hasActiveRun
          isUploading={false}
          onUploadDocument={vi.fn()}
          onDetachDocument={vi.fn()}
          onSend={vi.fn()}
          onStop={onStop}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="auto"
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )
    const stopButton = screen.getByRole('button', { name: '停止生成' })
    fireEvent.click(stopButton)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('keeps stop available and sends draft as an appended instruction during an active run', () => {
    const onStop = vi.fn()
    const onAppendInstruction = vi.fn()
    render(
      <I18nProvider>
        <Composer
          draft="先补失败测试"
          onDraftChange={vi.fn()}
          isSending
          hasActiveRun
          isUploading={false}
          onUploadDocument={vi.fn()}
          onDetachDocument={vi.fn()}
          onSend={vi.fn()}
          onAppendInstruction={onAppendInstruction}
          onStop={onStop}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="auto"
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(onStop).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '追加指示' }))
    expect(onAppendInstruction).toHaveBeenCalledTimes(1)
  })

  it('shows the appended-instruction placeholder while a local run is active', () => {
    render(
      <I18nProvider>
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          isSending={false}
          hasActiveRun
          isUploading={false}
          onUploadDocument={vi.fn()}
          onDetachDocument={vi.fn()}
          onSend={vi.fn()}
          onAppendInstruction={vi.fn()}
          onStop={vi.fn()}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="auto"
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('追加指示到当前任务')).toBeInTheDocument()
  })

  it('shows the send button (not stop) when neither isSending nor hasActiveRun is set', () => {
    render(<Harness />)
    // Stop button uses aria-label "停止生成" (i18n key composer.stop).
    expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
  })

  it('renders multiple attachment tiles and accepts multiple files from picker', () => {
    const onDetachDocument = vi.fn()
    const onUploadDocument = vi.fn()
    render(
      <I18nProvider>
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          isSending={false}
          isUploading={false}
          attachedDocuments={[
            documentFixture('doc-1', 'roadmap.pdf', 'application/pdf'),
            documentFixture('doc-2', 'budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
          ]}
          attachedPreviews={{ 'doc-1': 'data:image/png;base64,abc' }}
          onUploadDocument={onUploadDocument}
          onDetachDocument={onDetachDocument}
          onSend={vi.fn()}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="auto"
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByTitle(/roadmap\.pdf/)).toBeInTheDocument()
    expect(screen.getByTitle(/budget\.xlsx/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('附件模式')
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      '带附件的提问会走附件上下文，本次不混用网页搜索或生成图片工具。',
    )
    const removeButtons = screen.getAllByRole('button', { name: '移除附件' })
    fireEvent.click(removeButtons[1])
    expect(onDetachDocument).toHaveBeenCalledWith('doc-2')

    const input = screen.getByLabelText('上传附件') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ]
    fireEvent.change(input, { target: { files } })
    expect(onUploadDocument).toHaveBeenCalledWith(files)
  })
})

describe('formatDocumentExpiry', () => {
  // Locked to the Chinese translator so the assertions read in one
  // language. The behaviour is identical for `en` modulo wording.
  const t = createTranslator('zh')
  const now = new Date('2026-05-26T12:00:00Z')

  it('returns null for empty/invalid expires_at', () => {
    expect(formatDocumentExpiry('', now, t)).toBeNull()
    expect(formatDocumentExpiry(undefined, now, t)).toBeNull()
    expect(formatDocumentExpiry(null, now, t)).toBeNull()
    expect(formatDocumentExpiry('not-a-date', now, t)).toBeNull()
  })

  it('reports "expired" when expires_at is in the past', () => {
    const past = new Date(now.getTime() - 60_000).toISOString()
    expect(formatDocumentExpiry(past, now, t)).toBe('已过期')
  })

  it('reports "expires soon" when expires_at is within the next hour', () => {
    const in30Min = new Date(now.getTime() + 30 * 60_000).toISOString()
    expect(formatDocumentExpiry(in30Min, now, t)).toBe('即将过期')
  })

  it('reports hours when expires_at is within the next 24h', () => {
    const in5Hours = new Date(now.getTime() + 5 * 60 * 60_000).toISOString()
    expect(formatDocumentExpiry(in5Hours, now, t)).toBe('5 小时后过期')
  })

  it('reports days when expires_at is more than 24h out', () => {
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString()
    expect(formatDocumentExpiry(in7Days, now, t)).toBe('7 天后过期')
  })

  it('rounds down to the floor day count (3.9 days → "3 天")', () => {
    // 3 days + 22 hours — still shy of the 4-day mark, so floor(3.9)=3.
    const partial = new Date(now.getTime() + (3 * 24 + 22) * 60 * 60_000).toISOString()
    expect(formatDocumentExpiry(partial, now, t)).toBe('3 天后过期')
  })
})

describe('Composer attachment chip expiry caption', () => {
  function makeReadyDoc(overrides: Partial<AttachmentDocument> = {}): AttachmentDocument {
    return {
      id: 'doc-1',
      user_id: 'user-1',
      original_name: 'report.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
      status: 'ready',
      source_object_key: 'documents/user-1/doc-1/source.pdf',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    }
  }

  function renderWithDoc(doc: AttachmentDocument) {
    return render(
      <I18nProvider>
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          isSending={false}
          attachedDocument={doc}
          isUploading={false}
          onUploadDocument={vi.fn()}
          onDetachDocument={vi.fn()}
          onSend={vi.fn()}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="auto"
          onModeChange={vi.fn()}
        />
      </I18nProvider>,
    )
  }

  it('renders a visible expiry caption when the document is ready', () => {
    renderWithDoc(makeReadyDoc())
    // We rendered with a roughly-7-day window — the caption text should
    // start with the digit count and include "天后过期".
    const caption = screen.getByText(/天后过期/)
    expect(caption).toBeInTheDocument()
    expect(caption.classList.contains('attachment-expiry-caption')).toBe(true)
  })

  it('skips the caption while the document is still uploading', () => {
    renderWithDoc(makeReadyDoc({ status: 'uploading' }))
    // Spinner overlay + chip render, but no expiry caption — showing
    // "expires in 7 days" next to a still-uploading file reads wrong.
    expect(screen.queryByText(/过期/)).not.toBeInTheDocument()
  })

  it('skips the caption when the upload failed', () => {
    renderWithDoc(makeReadyDoc({ status: 'failed' }))
    expect(screen.queryByText(/过期/)).not.toBeInTheDocument()
  })
})
