export * from '@shejane/runtime-sdk'

import {
  SheJaneRuntimeClient,
  type RuntimeClientConfig,
} from '@shejane/runtime-sdk'

export interface DesktopBridge {
  platform: string
  localHost?: {
    baseURL?: string
    session?: 'desktop'
    ready?: boolean
  }
  openFileWithDefaultApp?: (filePath: string) => Promise<string>
}

export interface LocalHostConfig extends RuntimeClientConfig {
  session?: 'desktop'
}

export function getDesktopLocalHostConfig(
  bridge: DesktopBridge | undefined = window.shejaneDesktop,
): LocalHostConfig | undefined {
  const baseURL = bridge?.localHost?.baseURL?.trim()
  if (!baseURL) return undefined
  return {
    baseURL,
    ...(bridge?.localHost?.session === 'desktop' ? { session: 'desktop' as const } : {}),
  }
}

export function hasLocalHostAuthorization(
  config: LocalHostConfig | null | undefined,
): config is LocalHostConfig {
  return config?.session === 'desktop' || Boolean(config?.token)
}

export function createDesktopRuntimeClient(
  config: LocalHostConfig,
  fetcher: typeof fetch = fetch,
): SheJaneRuntimeClient {
  return new SheJaneRuntimeClient({ baseURL: config.baseURL, token: config.token, fetcher })
}
