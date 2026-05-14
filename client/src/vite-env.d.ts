/// <reference types="vite/client" />

interface Window {
  jiandanDesktop?: {
    platform: string
    localHost?: {
      baseURL?: string
      token?: string
    }
    auth?: {
      register(input: { email: string; password: string; name: string }): Promise<import('./shared/api/client').AuthPayload>
      login(input: { email: string; password: string }): Promise<import('./shared/api/client').AuthPayload>
      refresh(): Promise<import('./shared/api/client').AuthPayload>
      logout(): Promise<void>
    }
    selectWorkspaceDirectory?: () => Promise<string | undefined>
  }
}
