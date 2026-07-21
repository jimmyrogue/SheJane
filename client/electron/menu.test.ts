import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  appNameForLocale,
  applicationMenuTemplateForPlatform,
  desktopText,
  fileContextMenuTemplate,
  normalizeDesktopLocale,
  trayIconConfigForPlatform,
  windowMenuOptionsForPlatform,
} = require('./menu.cjs') as {
  appNameForLocale: (locale: string) => string
  applicationMenuTemplateForPlatform: (platform: NodeJS.Platform, locale: 'zh' | 'en') => unknown[] | null
  desktopText: (locale: string, key: string, params?: Record<string, unknown>) => string
  fileContextMenuTemplate: (platform: NodeJS.Platform, locale: 'zh' | 'en', canPreview: boolean, actions: Record<string, () => void>) => Array<{ label?: string, enabled?: boolean, click?: () => void }>
  normalizeDesktopLocale: (locale: string) => 'zh' | 'en'
  trayIconConfigForPlatform: (platform: NodeJS.Platform) => { filename: string; template: boolean }
  windowMenuOptionsForPlatform: (platform: NodeJS.Platform) => Record<string, boolean>
}

describe('Electron menu policy', () => {
  it('removes the native application menu on Windows and Linux', () => {
    expect(applicationMenuTemplateForPlatform('win32', 'zh')).toBeNull()
    expect(applicationMenuTemplateForPlatform('linux', 'zh')).toBeNull()
    expect(windowMenuOptionsForPlatform('win32')).toEqual({ autoHideMenuBar: true })
    expect(windowMenuOptionsForPlatform('linux')).toEqual({ autoHideMenuBar: true })
  })

  it('keeps the macOS menu localized instead of falling back to Electron defaults', () => {
    const zhMenu = JSON.stringify(applicationMenuTemplateForPlatform('darwin', 'zh'))
    const enMenu = JSON.stringify(applicationMenuTemplateForPlatform('darwin', 'en'))

    expect(zhMenu).toContain('新建对话')
    expect(zhMenu).toContain('隐藏石间')
    expect(zhMenu).not.toMatch(/\bFile\b|\bEdit\b|\bView\b|\bWindow\b|\bHelp\b/)
    expect(enMenu).toContain('New Chat')
    expect(enMenu).toContain('Hide SheJane')
  })

  it('normalizes system locales and localizes main-process strings', () => {
    expect(normalizeDesktopLocale('en-US')).toBe('en')
    expect(appNameForLocale('en-US')).toBe('SheJane')
    expect(desktopText('en-US', 'runtime.startFailed', { message: 'boom' })).toBe('Could not start the local engine: boom')
    expect(desktopText('en-US', 'dialogs.selectWorkspaceTitle')).toBe('Choose local workspace')
    expect(desktopText('zh-CN', 'dialogs.selectWorkspaceTitle')).toBe('选择本地工作区')
    expect(desktopText('zh-CN', 'update.readyMessage', { version: '0.1.12' })).toBe('石间 v0.1.12 已准备好')
  })

  it('uses template tray icons only on macOS', () => {
    expect(trayIconConfigForPlatform('darwin')).toEqual({ filename: 'app-tray.png', template: true })
    expect(trayIconConfigForPlatform('win32')).toEqual({ filename: 'app-tray-win.png', template: false })
    expect(trayIconConfigForPlatform('linux')).toEqual({ filename: 'app-tray-win.png', template: false })
  })

  it('builds a localized attachment menu with deterministic actions', () => {
    const selected: string[] = []
    const menu = fileContextMenuTemplate('darwin', 'zh', true, {
      onPreview: () => selected.push('preview'),
      onOpen: () => selected.push('open'),
      onSave: () => selected.push('save'),
      onReveal: () => selected.push('reveal'),
    })

    expect(menu.map(item => item.label).filter(Boolean)).toEqual([
      '预览',
      '打开',
      '保存副本',
      '在访达中显示',
    ])
    menu[0].click?.()
    expect(selected).toEqual(['preview'])
    expect(fileContextMenuTemplate('linux', 'en', false, {}).at(0)).toMatchObject({
      label: 'Preview',
      enabled: false,
    })
  })
})
