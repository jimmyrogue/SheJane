const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jiandanDesktop', {
  platform: process.platform,
  localHost: {
    baseURL: process.env.JIANDANLY_LOCAL_HOST_URL || 'http://127.0.0.1:17371',
    token: process.env.JIANDANLY_LOCAL_HOST_TOKEN || '',
  },
  auth: {
    register: (input) => ipcRenderer.invoke('jiandanly:auth-register', input),
    login: (input) => ipcRenderer.invoke('jiandanly:auth-login', input),
    refresh: () => ipcRenderer.invoke('jiandanly:auth-refresh'),
    logout: () => ipcRenderer.invoke('jiandanly:auth-logout'),
  },
  selectWorkspaceDirectory: () => ipcRenderer.invoke('jiandanly:select-workspace-directory'),
})
