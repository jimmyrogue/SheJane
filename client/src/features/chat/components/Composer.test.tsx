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
}: {
  initialDraft?: string
  onSend?: () => void
  listSkills?: () => Promise<InstalledSkill[]>
  onDraft?: (value: string) => void
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
})
