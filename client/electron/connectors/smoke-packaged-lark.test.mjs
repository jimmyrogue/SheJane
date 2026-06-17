import { describe, expect, it } from 'vitest'
import {
  defaultAppExecutable,
  larkProcessBelongsToPackagedResources,
  validateLarkStatus,
} from './smoke-packaged-lark.mjs'

describe('packaged Lark smoke helpers', () => {
  it('resolves default unpacked app executable paths for Windows and macOS', () => {
    expect(defaultAppExecutable({ platform: 'win32', releaseDir: 'release' })).toBe('release/win-unpacked/石间.exe')
    expect(defaultAppExecutable({ platform: 'darwin', arch: 'arm64', releaseDir: 'release' })).toBe(
      'release/mac-arm64/石间.app/Contents/MacOS/石间',
    )
  })

  it('accepts a bundled Windows Lark connector status with controlled auth state', () => {
    const errors = validateLarkStatus(
      {
        connector: {
          available: true,
          source: 'bundled',
          executable_path: 'C:\\SheJane\\resources\\connectors\\lark\\win32-x64\\lark-cli.exe',
        },
        connection: {
          status: 'needs_auth',
          last_error_code: 'lark_auth_required',
        },
      },
      { platform: 'win32' },
    )

    expect(errors).toEqual([])
  })

  it('rejects missing or non-bundled connector status', () => {
    const errors = validateLarkStatus(
      {
        connector: {
          available: false,
          source: 'missing',
          executable_path: null,
        },
        connection: {
          status: 'disconnected',
          last_error_code: '',
        },
      },
      { platform: 'win32' },
    )

    expect(errors).toContain('Lark connector is not available')
    expect(errors).toContain('Lark connector source is missing, expected bundled')
  })

  it('matches only packaged connector lark-cli processes', () => {
    expect(
      larkProcessBelongsToPackagedResources(
        '123 C:\\SheJane\\resources\\connectors\\lark\\win32-x64\\lark-cli.exe auth status',
      ),
    ).toBe(true)
    expect(larkProcessBelongsToPackagedResources('456 C:\\Users\\me\\bin\\lark-cli.exe auth status')).toBe(false)
  })
})
