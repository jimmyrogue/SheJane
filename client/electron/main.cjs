const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const path = require('node:path')
const { createElectronAuthHandlers } = require('./auth-bridge.cjs')

const isDev = process.env.ELECTRON_DEV === 'true'

function createWindow() {
  const windowOptions = {
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: '简单 Jiandan',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    backgroundColor: '#FAFAF9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  }

  const window = new BrowserWindow(windowOptions)

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    window.loadURL(process.env.ELECTRON_DEV_URL || 'http://localhost:5173')
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function apiBaseURL() {
  return process.env.JIANDANLY_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:8080'
}

function registerAuthHandlers() {
  const auth = createElectronAuthHandlers({
    apiBaseURL: apiBaseURL(),
    cookies: session.defaultSession.cookies,
    fetchImpl: globalThis.fetch,
  })

  ipcMain.handle('jiandanly:auth-register', (_event, input) => auth.register(input))
  ipcMain.handle('jiandanly:auth-login', (_event, input) => auth.login(input))
  ipcMain.handle('jiandanly:auth-refresh', () => auth.refresh())
  ipcMain.handle('jiandanly:auth-logout', () => auth.logout())
}

app.whenReady().then(() => {
  registerAuthHandlers()
  createWindow()
})

ipcMain.handle('jiandanly:select-workspace-directory', async () => {
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const options = {
    title: '选择本地工作区',
    properties: ['openDirectory'],
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return undefined
  }
  return result.filePaths[0]
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
