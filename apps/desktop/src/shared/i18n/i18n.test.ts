import { describe, expect, it } from 'vitest'
import { createTranslator, normalizeLocale } from './i18n'

describe('i18n', () => {
  it('normalizes supported locales and falls back to Chinese', () => {
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh')
    expect(normalizeLocale('fr-FR')).toBe('zh')
  })

  it('translates keys with interpolation for Chinese and English', () => {
    expect(createTranslator('zh')('composer.projectPicker.locked', { name: '示例项目' })).toBe('项目已锁定：示例项目（新建对话可换）')
    expect(createTranslator('en')('composer.projectPicker.locked', { name: 'Demo' })).toBe('Project locked: Demo (start a new chat to switch)')
  })

  it('keeps default Chinese desktop-facing copy natural', () => {
    const t = createTranslator('zh')
    const visibleCopy = [
      t('app.notice.artifactReadFailed'),
      t('sidebar.localFirst'),
      t('sidebar.agentSettings.title'),
      t('sidebar.agentSettings.description'),
      t('agent.artifactsCount', { count: 1 }),
      t('artifact.title', { title: 'demo' }),
    ].join('\n')

    expect(visibleCopy).toContain('智能体设置')
    expect(visibleCopy).toContain('产物')
    expect(visibleCopy).not.toMatch(/Credits|Local-first|Agent 设置|Artifact|default off|default observe|daemon/)
  })
})
