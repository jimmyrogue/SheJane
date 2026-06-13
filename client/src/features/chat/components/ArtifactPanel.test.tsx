import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { LocalArtifact } from '@/shared/local-host/client'
import { ArtifactPanel } from './ArtifactPanel'

afterEach(() => cleanup())

function artifact(overrides: Partial<LocalArtifact> = {}): LocalArtifact {
  return {
    id: 'artifact-1',
    title: 'report.md',
    content: '# Report\n\n```ts\nconst answer = 42\n```',
    tool_name: 'write_file',
    created_at: '2026-06-13T00:00:00Z',
    ...overrides,
  }
}

describe('ArtifactPanel', () => {
  it('renders markdown artifacts with highlighted fenced code and actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <I18nProvider>
        <ArtifactPanel artifact={artifact()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument()
    expect(document.body.querySelector('.code-block')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载产物' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制产物' }))
    expect(writeText).toHaveBeenCalledWith('# Report\n\n```ts\nconst answer = 42\n```')
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制产物' })).toBeInTheDocument())
  })

  it('renders html and svg artifacts inside a sandboxed iframe', () => {
    const { container, rerender } = render(
      <I18nProvider>
        <ArtifactPanel
          artifact={artifact({
            title: 'preview.html',
            content: '<!doctype html><html><body><h1>Hello</h1></body></html>',
          })}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    )

    const htmlFrame = document.body.querySelector('iframe.artifact-frame')
    expect(htmlFrame).toBeInTheDocument()
    expect(htmlFrame).toHaveAttribute('sandbox', '')
    expect(htmlFrame).toHaveAttribute('srcdoc', expect.stringContaining('<h1>Hello</h1>'))

    rerender(
      <I18nProvider>
        <ArtifactPanel
          artifact={artifact({
            title: 'diagram.svg',
            content: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
          })}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(document.body.querySelector('iframe.artifact-frame')).toHaveAttribute('srcdoc', expect.stringContaining('<svg'))
  })
})
