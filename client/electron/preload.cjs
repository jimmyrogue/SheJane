const { contextBridge, ipcRenderer } = require('electron')
const { unwrapAuthIPCResult } = require('./auth-bridge.cjs')

async function invokeAuth(channel, input) {
  return unwrapAuthIPCResult(await ipcRenderer.invoke(channel, input))
}

// Main passes only the Runtime address and an opaque session marker. The
// pairing token never crosses into the renderer process.
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
    session:
      argValue('--shejane-local-host-session=') === 'desktop'
        ? 'desktop'
        : undefined,
    ready: argValue('--shejane-local-host-ready=') === 'true',
  },
  runtimeConnection: {
    get: () => ipcRenderer.invoke('shejane:runtime-connection-get'),
    set: (input) => ipcRenderer.invoke('shejane:runtime-connection-set', input),
    restartApp: () => ipcRenderer.invoke('shejane:restart-app'),
  },
  auth: {
    register: (input) => invokeAuth('shejane:auth-register', input),
    login: (input) => invokeAuth('shejane:auth-login', input),
    refresh: () => invokeAuth('shejane:auth-refresh'),
    logout: () => invokeAuth('shejane:auth-logout'),
  },
  selectWorkspaceDirectory: () => ipcRenderer.invoke('shejane:select-workspace-directory'),
  openExternal: (url) => ipcRenderer.invoke('shejane:open-external', url),
  setLocale: (locale) => ipcRenderer.invoke('shejane:set-locale', locale),
  setWindowButtonPosition: (position) => ipcRenderer.invoke('shejane:set-window-button-position', position),
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
  onDeepLink: (handler) => {
    const wrapped = (_event, url) => handler(url)
    ipcRenderer.on('shejane:deep-link', wrapped)
    return () => ipcRenderer.removeListener('shejane:deep-link', wrapped)
  },
})
