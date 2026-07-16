/// <reference types="vite/client" />

interface Window {
  shejaneDesktop?: {
    platform: string
    localHost?: {
      baseURL?: string
      session?: 'desktop'
      ready?: boolean
    }
    runtimeConnection?: {
      get(): Promise<{
        mode: 'bundled' | 'external-local'
        source: 'default' | 'saved' | 'environment'
        state: 'ready' | 'offline'
        baseURL?: string
        tokenConfigured?: boolean
        error?: string
      }>
      set(input:
        | { mode: 'bundled' }
        | { mode: 'external-local', baseURL: string, token?: string }
      ): Promise<unknown>
      restartApp(): Promise<void>
    }
    selectWorkspaceDirectory?: () => Promise<string | undefined>
    selectAttachmentFiles?: () => Promise<string[]>
    selectPluginPackage?: () => Promise<string | undefined>
    openExternal?: (url: string) => Promise<string>
    setLocale?: (locale: 'zh' | 'en') => Promise<'zh' | 'en'>
    setWindowButtonPosition?: (position: 'app') => Promise<boolean>
    notify?: (payload: { title: string; body: string }) => Promise<boolean>
    onNewChatRequest?: (handler: () => void) => () => void
    /** Open a file with the OS's default app. Resolves to "" on
     *  success, an error message string otherwise (mirrors Electron
     *  `shell.openPath`). Used by PptxPreview's "Open in PowerPoint". */
    openFileWithDefaultApp?: (filePath: string) => Promise<string>
  }
}
