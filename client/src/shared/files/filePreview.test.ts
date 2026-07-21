import { describe, expect, it } from 'vitest'

import { filePreviewKind, isPreviewableFile } from './filePreview'

describe('filePreview', () => {
  it.each([
    ['report.docx', 'word'],
    ['budget.XLSX', 'excel'],
    ['deck.pptx', 'powerpoint'],
    ['paper.pdf', 'pdf'],
    ['server.ts', 'code'],
    ['notes.md', 'text'],
    ['photo.png', 'image'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(filePreviewKind(name)).toBe(kind)
    expect(isPreviewableFile(name)).toBe(true)
  })

  it('keeps legacy Office and unknown binary files external-only', () => {
    expect(filePreviewKind('legacy.doc')).toBeUndefined()
    expect(filePreviewKind('archive.zip')).toBeUndefined()
  })
})
