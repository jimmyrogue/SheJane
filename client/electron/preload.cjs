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
})
