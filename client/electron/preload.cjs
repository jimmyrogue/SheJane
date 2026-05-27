const { contextBridge, ipcRenderer } = require('electron')
const { unwrapAuthIPCResult } = require('./auth-bridge.cjs')

async function invokeAuth(channel, input) {
  return unwrapAuthIPCResult(await ipcRenderer.invoke(channel, input))
}

contextBridge.exposeInMainWorld('jiandanDesktop', {
  platform: process.platform,
  localHost: {
    baseURL: process.env.JIANDANLY_LOCAL_HOST_URL || 'http://127.0.0.1:17371',
    token: process.env.JIANDANLY_LOCAL_HOST_TOKEN || '',
  },
  auth: {
    register: (input) => invokeAuth('jiandanly:auth-register', input),
    login: (input) => invokeAuth('jiandanly:auth-login', input),
    refresh: () => invokeAuth('jiandanly:auth-refresh'),
    logout: () => invokeAuth('jiandanly:auth-logout'),
  },
  selectWorkspaceDirectory: () => ipcRenderer.invoke('jiandanly:select-workspace-directory'),
  setLocale: (locale) => ipcRenderer.invoke('jiandanly:set-locale', locale),
  notify: (payload) => ipcRenderer.invoke('jiandanly:notify', payload),
  /** Open a file with the OS's default application — used by the
   *  right-side PptxPreview's "Open in PowerPoint" button. */
  openFileWithDefaultApp: (filePath) =>
    ipcRenderer.invoke('jiandanly:open-file-with-default-app', filePath),
  /** Reveal a file in Finder / Explorer (file highlighted in the
   *  folder). Used by the message-bubble attachment chip's external-
   *  open button for LOCAL workspace files. Cloud-only files don't
   *  have a stable path so they go through a browser download
   *  instead — this bridge is local-files-only. */
  showItemInFolder: (filePath) =>
    ipcRenderer.invoke('jiandanly:show-item-in-folder', filePath),
  /** Subscribe to the tray's "New Chat" action. Returns an unsubscribe
   *  fn so React effects can clean up properly. */
  onNewChatRequest: (handler) => {
    const wrapped = () => handler()
    ipcRenderer.on('jiandanly:new-chat', wrapped)
    return () => ipcRenderer.removeListener('jiandanly:new-chat', wrapped)
  },
})
