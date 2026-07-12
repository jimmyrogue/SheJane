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
    auth?: {
      register(input: { email: string; password: string; name: string }): Promise<import('./shared/api/client').AuthPayload>
      login(input: { email: string; password: string }): Promise<import('./shared/api/client').AuthPayload>
      refresh(): Promise<import('./shared/api/client').AuthPayload>
      logout(): Promise<void>
    }
    selectWorkspaceDirectory?: () => Promise<string | undefined>
    openExternal?: (url: string) => Promise<string>
    setLocale?: (locale: 'zh' | 'en') => Promise<'zh' | 'en'>
    setWindowButtonPosition?: (position: 'app' | 'auth') => Promise<boolean>
    notify?: (payload: { title: string; body: string }) => Promise<boolean>
    onNewChatRequest?: (handler: () => void) => () => void
    onDeepLink?: (handler: (url: string) => void) => () => void
    /** Open a file with the OS's default app. Resolves to "" on
     *  success, an error message string otherwise (mirrors Electron
     *  `shell.openPath`). Used by PptxPreview's "Open in PowerPoint". */
    openFileWithDefaultApp?: (filePath: string) => Promise<string>
    /** Reveal a file in Finder / Explorer with the file highlighted
     *  in its containing folder. Resolves to 'ok' on success, an
     *  error string otherwise. Used by the message-bubble attachment
     *  chip's external-open button for local workspace files. */
    showItemInFolder?: (filePath: string) => Promise<string>
  }
}
