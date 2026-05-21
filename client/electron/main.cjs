const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { authIPCResult, createElectronAuthHandlers } = require('./auth-bridge.cjs')

const isDev = process.env.ELECTRON_DEV === 'true'
const dockLangFile =
  process.env.SHEJANE_DOCK_LANG_FILE || path.resolve(__dirname, '..', '..', '.tmp', 'dev', 'dock-lang')
function readDockLocale() {
  try {
    const value = fs.readFileSync(dockLangFile, 'utf8').trim()
    return value === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}
const appName = readDockLocale() === 'en' ? 'SheJane' : '石间'
const appIconPath = path.join(__dirname, 'assets/app-icon.png')

function createWindow() {
  const windowOptions = {
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: appName,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    icon: appIconPath,
    backgroundColor: '#FAFAF9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

app.setName(appName)

function apiBaseURL() {
  return process.env.JIANDANLY_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:8080'
}

function registerAuthHandlers() {
  const auth = createElectronAuthHandlers({
    apiBaseURL: apiBaseURL(),
    cookies: session.defaultSession.cookies,
    fetchImpl: globalThis.fetch,
  })

  ipcMain.handle('jiandanly:auth-register', (_event, input) => authIPCResult(() => auth.register(input)))
  ipcMain.handle('jiandanly:auth-login', (_event, input) => authIPCResult(() => auth.login(input)))
  ipcMain.handle('jiandanly:auth-refresh', () => authIPCResult(() => auth.refresh()))
  ipcMain.handle('jiandanly:auth-logout', () => authIPCResult(() => auth.logout()))
}

app.whenReady().then(() => {
  app.setName(appName)
  if (process.platform === 'darwin') {
    app.dock.setIcon(appIconPath)
  }
  registerAuthHandlers()
  createWindow()
})

ipcMain.handle('jiandanly:set-locale', async (_event, locale) => {
  const normalized = locale === 'en' ? 'en' : 'zh'
  try {
    fs.mkdirSync(path.dirname(dockLangFile), { recursive: true })
    fs.writeFileSync(dockLangFile, normalized, 'utf8')
  } catch {
    // Best-effort: if disk write fails, dock label simply won't update next launch.
  }
  return normalized
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
