import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, createTranslator } from '@/shared/i18n/i18n'
import { Composer, formatDocumentExpiry } from './Composer'
import { skillToken } from '../skillDraft'
import type { InstalledSkill } from '@/shared/local-host/client'
import type { UserDocument } from '@/shared/api/client'

afterEach(cleanup)

const sampleSkills: InstalledSkill[] = [
  { name: 'hunt', description: 'Diagnose before you fix', path: '/s/hunt/SKILL.md' },
  { name: 'write', description: 'Strip AI writing patterns', path: '/s/write/SKILL.md' },
]

function Harness({
  initialDraft = '',
  onSend = vi.fn(),
  listSkills = vi.fn().mockResolvedValue(sampleSkills),
  onDraft = vi.fn(),
  projectName,
  onSelectProject,
}: {
  initialDraft?: string
  onSend?: () => void
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
    expect(screen.getByText('描述你的问题、任务，或让石间阅读附件')).toBeInTheDocument()
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
  // stop visibility off `isSending || hasActiveLocalRun`.
  it('shows the stop button when a run is still active even if isSending is false', () => {
    const onStop = vi.fn()
    render(
      <I18nProvider>
        <Composer
          draft=""
          onDraftChange={vi.fn()}
          isSending={false}
          hasActiveLocalRun
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

  it('shows the send button (not stop) when neither isSending nor hasActiveLocalRun is set', () => {
    render(<Harness />)
    // Stop button uses aria-label "停止生成" (i18n key composer.stop).
    expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
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
  function makeReadyDoc(overrides: Partial<UserDocument> = {}): UserDocument {
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

  function renderWithDoc(doc: UserDocument) {
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
