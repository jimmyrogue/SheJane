const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} = require('electron')
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

/** Module-scope references so tray/menu/notification handlers can find
 *  the main window without searching every time. */
let mainWindow = null
let tray = null

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
  mainWindow = window

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Close-to-tray: clicking the red traffic light (or Cmd+W) hides
  // the window instead of quitting, so the app keeps running in the
  // tray. Real quit only happens when the user explicitly chooses Quit
  // from the tray menu (which sets app.isQuitting).
  window.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  if (isDev) {
    window.loadURL(process.env.ELECTRON_DEV_URL || 'http://localhost:5173')
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function showOrCreateMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(appIconPath).resize({ width: 18, height: 18 })
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true)
  }
  tray = new Tray(trayIcon)
  tray.setToolTip(appName)
  const locale = readDockLocale()
  const labels =
    locale === 'en'
      ? { show: 'Show', newChat: 'New Chat', quit: 'Quit' }
      : { show: '显示主窗口', newChat: '新建对话', quit: '退出' }
  const menu = Menu.buildFromTemplate([
    {
      label: labels.show,
      click: () => showOrCreateMainWindow(),
    },
    {
      label: labels.newChat,
      accelerator: process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
      click: () => {
        showOrCreateMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('jiandanly:new-chat')
        }
      },
    },
    { type: 'separator' },
    { label: labels.quit, role: 'quit' },
  ])
  tray.setContextMenu(menu)
  // Single click on the tray icon: bring the window forward. Right-click
  // shows the context menu on its own (platform-default).
  tray.on('click', () => showOrCreateMainWindow())
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
  createTray()
})

// Marker that "real quit" was requested (vs. window-close). The close
// handler on the main window checks this flag to decide whether to hide
// to tray or actually let the close go through.
app.on('before-quit', () => {
  app.isQuitting = true
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

/** Surface a native OS notification. Returns `false` when the main
 *  window is currently focused — in that case the user can already see
 *  whatever just happened, so adding a notification on top is noise.
 *  Clicking the notification brings the main window forward. */
ipcMain.handle('jiandanly:notify', async (_event, payload) => {
  if (!Notification.isSupported()) {
    return false
  }
  const title = typeof payload?.title === 'string' ? payload.title : appName
  const body = typeof payload?.body === 'string' ? payload.body : ''
  if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) {
    return false
  }
  const notification = new Notification({ title, body, silent: false })
  notification.on('click', () => {
    showOrCreateMainWindow()
  })
  notification.show()
  return true
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

ipcMain.handle('jiandanly:open-file-with-default-app', async (_event, filePath) => {
  // Used by the right-side PptxPreview "Open in PowerPoint" button.
  // Returns "" on success (Electron's contract) or an error message
  // string on failure.
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'path required'
  }
  try {
    return await shell.openPath(filePath)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
})

app.on('window-all-closed', () => {
  // Intentionally do NOT app.quit() here — the tray keeps the app
  // alive across all OSes after the user "closes" the window. Real
  // quit is via the tray menu's Quit item (role: 'quit'), which
  // bypasses the close-to-tray guard via the before-quit flag.
})

app.on('activate', () => {
  showOrCreateMainWindow()
})
