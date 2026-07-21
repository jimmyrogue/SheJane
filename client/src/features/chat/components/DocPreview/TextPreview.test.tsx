import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TextPreview } from './TextPreview'

afterEach(() => cleanup())

describe('TextPreview', () => {
  it('renders UTF-8 text and reports ready', async () => {
    const onStatus = vi.fn()
    const bytes = new TextEncoder().encode('石间 preview').buffer
    render(
      <TextPreview
        sourceKey="notes.txt"
        name="notes.txt"
        kind="text"
        loadBytes={() => Promise.resolve(bytes)}
        onStatus={onStatus}
      />,
    )

    expect(await screen.findByText('石间 preview')).toBeInTheDocument()
    expect(onStatus).toHaveBeenNthCalledWith(1, 'loading')
    expect(onStatus).toHaveBeenLastCalledWith('ready')
  })

  it('caps large previews before decoding and marks the result truncated', async () => {
    const bytes = new TextEncoder().encode(`${'a'.repeat(512 * 1024)}DO_NOT_RENDER`).buffer
    const { container } = render(
      <TextPreview
        sourceKey="large.log"
        name="large.log"
        kind="text"
        loadBytes={() => Promise.resolve(bytes)}
      />,
    )

    const preview = await screen.findByText(/preview truncated/)
    expect(preview).not.toHaveTextContent('DO_NOT_RENDER')
    expect(container.querySelector('.doc-preview-text')).toBe(preview)
  })
})
