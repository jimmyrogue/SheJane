import { describe, expect, it } from 'vitest'
import { fileIconFor, isInAppPreviewable } from './fileIcons'

describe('fileIconFor', () => {
  it('returns the PDF descriptor for *.pdf names', () => {
    expect(fileIconFor('paper.pdf').colorKey).toBe('pdf')
    expect(fileIconFor('NIPS-2017-attention-is-all-you-need-Paper.pdf').colorKey).toBe('pdf')
  })

  it('returns the word descriptor for .docx and .doc names', () => {
    expect(fileIconFor('report.docx').colorKey).toBe('word')
    expect(fileIconFor('legacy.doc').colorKey).toBe('word')
  })

  it('returns the excel descriptor for .xlsx / .xls / .csv', () => {
    expect(fileIconFor('budget.xlsx').colorKey).toBe('excel')
    expect(fileIconFor('legacy.xls').colorKey).toBe('excel')
    expect(fileIconFor('users.csv').colorKey).toBe('excel')
  })

  it('returns the powerpoint descriptor for .pptx / .ppt', () => {
    expect(fileIconFor('deck.pptx').colorKey).toBe('powerpoint')
    expect(fileIconFor('legacy.ppt').colorKey).toBe('powerpoint')
  })

  it('returns the image descriptor for common image extensions', () => {
    for (const name of ['photo.png', 'photo.jpg', 'photo.jpeg', 'photo.webp', 'photo.gif', 'photo.bmp', 'photo.svg']) {
      expect(fileIconFor(name).colorKey).toBe('image')
    }
  })

  it('falls back to MIME when the extension is missing or unrecognized', () => {
    // No useful extension, but content type is unambiguous.
    expect(fileIconFor('blob', 'application/pdf').colorKey).toBe('pdf')
    expect(fileIconFor('blob', 'image/png').colorKey).toBe('image')
    expect(
      fileIconFor(
        'blob',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).colorKey,
    ).toBe('excel')
  })

  it('returns the generic "other" descriptor when nothing matches', () => {
    expect(fileIconFor('mystery').colorKey).toBe('other')
    expect(fileIconFor('mystery.xyz', 'application/octet-stream').colorKey).toBe('other')
  })

  it('is case-insensitive on extension matching', () => {
    expect(fileIconFor('REPORT.PDF').colorKey).toBe('pdf')
    expect(fileIconFor('REPORT.DocX').colorKey).toBe('word')
  })
})

describe('isInAppPreviewable', () => {
  it('treats pdf/word/excel as previewable in the side panel', () => {
    expect(isInAppPreviewable('a.pdf')).toBe(true)
    expect(isInAppPreviewable('a.docx')).toBe(true)
    expect(isInAppPreviewable('a.xlsx')).toBe(true)
  })

  it('treats images and unknown types as NOT previewable (different routes handle them)', () => {
    expect(isInAppPreviewable('a.png')).toBe(false)
    expect(isInAppPreviewable('a.zip')).toBe(false)
    expect(isInAppPreviewable('mystery')).toBe(false)
  })

  it('treats pptx as not-previewable from this helper (PptxPreview needs a local path, handled separately)', () => {
    expect(isInAppPreviewable('a.pptx')).toBe(false)
  })
})
