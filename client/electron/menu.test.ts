import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  applicationMenuTemplateForPlatform,
  trayIconConfigForPlatform,
  windowMenuOptionsForPlatform,
} = require('./menu.cjs') as {
  applicationMenuTemplateForPlatform: (platform: NodeJS.Platform, locale: 'zh' | 'en') => unknown[] | null
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

  it('uses template tray icons only on macOS', () => {
    expect(trayIconConfigForPlatform('darwin')).toEqual({ filename: 'app-tray.png', template: true })
    expect(trayIconConfigForPlatform('win32')).toEqual({ filename: 'app-tray-win.png', template: false })
    expect(trayIconConfigForPlatform('linux')).toEqual({ filename: 'app-tray-win.png', template: false })
  })
})
