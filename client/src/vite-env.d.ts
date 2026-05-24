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
    setLocale?: (locale: 'zh' | 'en') => Promise<'zh' | 'en'>
    notify?: (payload: { title: string; body: string }) => Promise<boolean>
    onNewChatRequest?: (handler: () => void) => () => void
    /** Open a file with the OS's default app. Resolves to "" on
     *  success, an error message string otherwise (mirrors Electron
     *  `shell.openPath`). Used by PptxPreview's "Open in PowerPoint". */
    openFileWithDefaultApp?: (filePath: string) => Promise<string>
  }
}
