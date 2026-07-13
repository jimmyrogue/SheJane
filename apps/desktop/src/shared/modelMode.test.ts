import { describe, expect, it } from 'vitest'
import { autoIntentFromMode, autoModeLabelKey, isAutoMode } from './modelMode'

describe('model mode helpers', () => {
  it('recognizes Auto sentinel modes and concrete model ids', () => {
    expect(isAutoMode('auto')).toBe(true)
    expect(isAutoMode('auto.fast')).toBe(true)
    expect(isAutoMode('auto.smart')).toBe(true)
    expect(isAutoMode('gpt-4o')).toBe(false)
  })

  it('extracts Auto intent from sentinel modes', () => {
    expect(autoIntentFromMode('auto')).toBe('')
    expect(autoIntentFromMode('auto.fast')).toBe('fast')
    expect(autoIntentFromMode('auto.smart')).toBe('smart')
    expect(autoIntentFromMode('deepseek-v4-pro')).toBe('')
  })

  it('returns the i18n label key for Auto sentinel modes', () => {
    expect(autoModeLabelKey('auto')).toBe('composer.mode.auto')
    expect(autoModeLabelKey('auto.fast')).toBe('composer.mode.intentFast')
    expect(autoModeLabelKey('auto.smart')).toBe('composer.mode.intentSmart')
  })
})
