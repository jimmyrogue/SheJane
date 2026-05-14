import { describe, expect, it } from 'vitest'
import { createTranslator, normalizeLocale } from './i18n'

describe('i18n', () => {
  it('normalizes supported locales and falls back to Chinese', () => {
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh')
    expect(normalizeLocale('fr-FR')).toBe('zh')
  })

  it('translates keys with interpolation for Chinese and English', () => {
    expect(createTranslator('zh')('composer.attachedDocument', { name: 'brief.docx' })).toBe('已附加 brief.docx')
    expect(createTranslator('en')('composer.attachedDocument', { name: 'brief.docx' })).toBe('Attached brief.docx')
  })
})
