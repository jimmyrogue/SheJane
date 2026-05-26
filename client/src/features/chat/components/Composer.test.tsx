import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { Composer } from './Composer'
import { skillToken } from '../skillDraft'
import type { InstalledSkill } from '@/shared/local-host/client'

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
