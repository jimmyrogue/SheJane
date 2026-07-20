const { contextBridge, ipcRenderer } = require('electron')

// Main passes only the Runtime address and an opaque session marker. The
// pairing token never crosses into the renderer process.
function argValue(prefix) {
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}

contextBridge.exposeInMainWorld('shejaneClient', {
  platform: process.platform,
  runtime: {
    baseURL:
      argValue('--shejane-runtime-url=') ||
      process.env.SHEJANE_RUNTIME_URL ||
      'http://127.0.0.1:17371',
    session:
      argValue('--shejane-runtime-session=') === 'client'
        ? 'client'
        : undefined,
    ready: argValue('--shejane-runtime-ready=') === 'true',
  },
  runtimeConnection: {
    get: () => ipcRenderer.invoke('shejane:runtime-connection-get'),
    set: (input) => ipcRenderer.invoke('shejane:runtime-connection-set', input),
    restartApp: () => ipcRenderer.invoke('shejane:restart-app'),
  },
  selectWorkspaceDirectory: () => ipcRenderer.invoke('shejane:select-workspace-directory'),
  selectAttachmentFiles: () => ipcRenderer.invoke('shejane:select-attachment-files'),
  selectPluginPackage: () => ipcRenderer.invoke('shejane:select-plugin-package'),
  openExternal: (url) => ipcRenderer.invoke('shejane:open-external', url),
  setLocale: (locale) => ipcRenderer.invoke('shejane:set-locale', locale),
  setWindowButtonPosition: (position) => ipcRenderer.invoke('shejane:set-window-button-position', position),
  notify: (payload) => ipcRenderer.invoke('shejane:notify', payload),
  /** Open a file with the OS's default application — used by the
   *  right-side PptxPreview's "Open in PowerPoint" button. */
  openFileWithDefaultApp: (filePath) =>
    ipcRenderer.invoke('shejane:open-file-with-default-app', filePath),
  /** Subscribe to the tray's "New Chat" action. Returns an unsubscribe
   *  fn so React effects can clean up properly. */
  onNewChatRequest: (handler) => {
    const wrapped = () => handler()
    ipcRenderer.on('shejane:new-chat', wrapped)
    return () => ipcRenderer.removeListener('shejane:new-chat', wrapped)
  },
})
