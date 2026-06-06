const { contextBridge, ipcRenderer } = require('electron')
const { unwrapAuthIPCResult } = require('./auth-bridge.cjs')

async function invokeAuth(channel, input) {
  return unwrapAuthIPCResult(await ipcRenderer.invoke(channel, input))
}

// The packaged app passes the daemon URL+token as preload args (reliable across
// the main→renderer process boundary); dev sets them in the env via
// scripts/dev-electron.sh. Read args first, fall back to env.
function argValue(prefix) {
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}

contextBridge.exposeInMainWorld('shejaneDesktop', {
  platform: process.platform,
  localHost: {
    baseURL:
      argValue('--shejane-local-host-url=') ||
      process.env.SHEJANE_LOCAL_HOST_URL ||
      'http://127.0.0.1:17371',
    token: argValue('--shejane-local-host-token=') || process.env.SHEJANE_LOCAL_HOST_TOKEN || '',
  },
  auth: {
    register: (input) => invokeAuth('shejane:auth-register', input),
    login: (input) => invokeAuth('shejane:auth-login', input),
    refresh: () => invokeAuth('shejane:auth-refresh'),
    logout: () => invokeAuth('shejane:auth-logout'),
  },
  selectWorkspaceDirectory: () => ipcRenderer.invoke('shejane:select-workspace-directory'),
  setLocale: (locale) => ipcRenderer.invoke('shejane:set-locale', locale),
  notify: (payload) => ipcRenderer.invoke('shejane:notify', payload),
  /** Open a file with the OS's default application — used by the
   *  right-side PptxPreview's "Open in PowerPoint" button. */
  openFileWithDefaultApp: (filePath) =>
    ipcRenderer.invoke('shejane:open-file-with-default-app', filePath),
  /** Reveal a file in Finder / Explorer (file highlighted in the
   *  folder). Used by the message-bubble attachment chip's external-
   *  open button for LOCAL workspace files. Cloud-only files don't
   *  have a stable path so they go through a browser download
   *  instead — this bridge is local-files-only. */
  showItemInFolder: (filePath) =>
    ipcRenderer.invoke('shejane:show-item-in-folder', filePath),
  /** Subscribe to the tray's "New Chat" action. Returns an unsubscribe
   *  fn so React effects can clean up properly. */
  onNewChatRequest: (handler) => {
    const wrapped = () => handler()
    ipcRenderer.on('shejane:new-chat', wrapped)
    return () => ipcRenderer.removeListener('shejane:new-chat', wrapped)
  },
})
