/// <reference types="vite/client" />

interface Window {
  jiandanDesktop?: {
    platform: string
    localHost?: {
      baseURL?: string
      token?: string
    }
    selectWorkspaceDirectory?: () => Promise<string | undefined>
  }
}
