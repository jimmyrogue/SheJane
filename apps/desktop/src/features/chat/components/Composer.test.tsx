import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { Composer } from './Composer'
import { skillToken } from '../skillDraft'
import type { InstalledSkill } from '@/shared/local-host/client'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sampleSkills: InstalledSkill[] = [
  { name: 'hunt', description: 'Diagnose before you fix', path: '/s/hunt/SKILL.md' },
  { name: 'write', description: 'Strip AI writing patterns', path: '/s/write/SKILL.md' },
]

function Harness({
  initialDraft = '',
  onSend = vi.fn(),
  onAppendInstruction,
  listSkills = vi.fn().mockResolvedValue(sampleSkills),
  onDraft = vi.fn(),
  projectName,
  onSelectProject,
  onRemoveProject,
  attachments = [],
  onSelectAttachments,
  onRemoveAttachment,
  hasActiveRun = false,
  permissionMode = 'ask',
  onPermissionModeChange = vi.fn(),
}: {
  initialDraft?: string
  onSend?: () => void
  onAppendInstruction?: () => void
  listSkills?: () => Promise<InstalledSkill[]>
  onDraft?: (value: string) => void
  projectName?: string
  onSelectProject?: () => void
  onRemoveProject?: () => void
  attachments?: Array<{ path: string; name: string }>
  onSelectAttachments?: () => void
  onRemoveAttachment?: (path: string) => void
  hasActiveRun?: boolean
  permissionMode?: 'ask' | 'auto' | 'full_access'
  onPermissionModeChange?: (mode: 'ask' | 'auto' | 'full_access') => void
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
        hasActiveRun={hasActiveRun}
        onSend={onSend}
        onAppendInstruction={onAppendInstruction}
        listSkills={listSkills}
        mode="local:test:model"
        onModeChange={vi.fn()}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        projectName={projectName}
        onSelectProject={onSelectProject}
        onRemoveProject={onRemoveProject}
        attachments={attachments}
        onSelectAttachments={onSelectAttachments}
        onRemoveAttachment={onRemoveAttachment}
      />
    </I18nProvider>
  )
}

describe('Composer (Lexical skill editor)', () => {
  it('renders the editor with a placeholder when empty', () => {
    render(<Harness />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByText('交给石间——描述任务，可添加附件')).toBeInTheDocument()
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

  it('shows a project chip when a project is bound', () => {
    const onSelectProject = vi.fn()
    render(<Harness projectName="客户A" onSelectProject={onSelectProject} />)
    // Project name is visible on the chip…
    expect(screen.getByText('客户A').closest('.composer-project-chip')).not.toHaveClass('composer-tool')
    // …and the "添加项目" affordance is gone.
    expect(screen.queryByRole('button', { name: '添加项目' })).not.toBeInTheDocument()
  })

  it('lets the user remove a bound project', () => {
    const onRemoveProject = vi.fn()
    render(<Harness projectName="客户A" onRemoveProject={onRemoveProject} />)

    fireEvent.click(screen.getByRole('button', { name: '移除路径：客户A' }))
    expect(onRemoveProject).toHaveBeenCalledTimes(1)
  })

  it('lets the user replace a bound project', () => {
    const onSelectProject = vi.fn()
    render(<Harness projectName="客户A" onSelectProject={onSelectProject} />)

    fireEvent.click(screen.getByRole('button', { name: '更换路径：客户A' }))
    expect(onSelectProject).toHaveBeenCalledTimes(1)
  })

  it('keeps project removal disabled while a run is active', () => {
    render(<Harness projectName="客户A" onRemoveProject={vi.fn()} hasActiveRun />)
    expect(screen.getByRole('button', { name: '移除路径：客户A' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '更换路径：客户A' })).toBeDisabled()
  })

  it('selects and removes local attachments', () => {
    const onSelectAttachments = vi.fn()
    const onRemoveAttachment = vi.fn()
    render(
      <Harness
        attachments={[{ path: '/tmp/brief.pdf', name: 'brief.pdf' }]}
        onSelectAttachments={onSelectAttachments}
        onRemoveAttachment={onRemoveAttachment}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }))
    fireEvent.click(screen.getByRole('button', { name: '移除附件：brief.pdf' }))

    expect(onSelectAttachments).toHaveBeenCalledTimes(1)
    expect(onRemoveAttachment).toHaveBeenCalledWith('/tmp/brief.pdf')
  })

  it('keeps the placeholder positioned inside the editor when attachments are present', () => {
    render(<Harness attachments={[{ path: '/tmp/brief.pdf', name: 'brief.pdf' }]} />)

    expect(screen.getByText('交给石间——描述任务，可添加附件').parentElement).toHaveClass(
      'composer-editor-shell',
    )
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
          onSend={vi.fn()}
          onStop={onStop}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="local:test:model"
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
          onSend={vi.fn()}
          onAppendInstruction={onAppendInstruction}
          onStop={onStop}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="local:test:model"
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
          onSend={vi.fn()}
          onAppendInstruction={vi.fn()}
          onStop={vi.fn()}
          listSkills={vi.fn().mockResolvedValue([])}
          mode="local:test:model"
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

  it('lets the user choose automatic approval before starting a run', async () => {
    const onPermissionModeChange = vi.fn()
    render(<Harness onPermissionModeChange={onPermissionModeChange} />)

    const trigger = screen.getByRole('button', { name: '权限模式：请求批准' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /自动审批/ }))

    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('requires confirmation before enabling full access', async () => {
    const onPermissionModeChange = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Harness onPermissionModeChange={onPermissionModeChange} />)

    const trigger = screen.getByRole('button', { name: '权限模式：请求批准' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /完全访问/ }))

    expect(onPermissionModeChange).not.toHaveBeenCalled()
  })


})
