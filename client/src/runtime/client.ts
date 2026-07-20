export * from '@shejane/runtime-sdk'

import {
  SheJaneRuntimeClient,
  type RuntimeClientConfig,
} from '@shejane/runtime-sdk'

export interface ClientBridge {
  platform: string
  runtime?: {
    baseURL?: string
    session?: 'client'
    ready?: boolean
  }
  openFileWithDefaultApp?: (filePath: string) => Promise<string>
}

export interface RuntimeConnection extends RuntimeClientConfig {
  session?: 'client'
}

export function getRuntimeConnection(
  bridge: ClientBridge | undefined = window.shejaneClient,
): RuntimeConnection | undefined {
  const baseURL = bridge?.runtime?.baseURL?.trim()
  if (!baseURL) return undefined
  return {
    baseURL,
    ...(bridge?.runtime?.session === 'client' ? { session: 'client' as const } : {}),
  }
}

export function hasRuntimeAuthorization(
  config: RuntimeConnection | null | undefined,
): config is RuntimeConnection {
  return config?.session === 'client' || Boolean(config?.token)
}

export function createRuntimeClient(
  config: RuntimeConnection,
  fetcher: typeof fetch = fetch,
): SheJaneRuntimeClient {
  return new SheJaneRuntimeClient({ baseURL: config.baseURL, token: config.token, fetcher })
}
