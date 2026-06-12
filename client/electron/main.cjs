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
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const net = require('node:net')
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
// Separate path for the menu-bar (Tray) icon. macOS template images
// must be a black + transparent mask — the full-color app-icon.png
// rendered as nothing visible because `setTemplateImage(true)`
// discards color. app-tray.png is a hand-tuned stone silhouette
// matching the product name 石间. Electron auto-loads `@2x` for
// Retina menu bars when the file sits in the same directory.
const trayIconPath = path.join(__dirname, 'assets/app-tray.png')

/** Module-scope references so tray/menu/notification handlers can find
 *  the main window without searching every time. */
let mainWindow = null
let tray = null
// Bundled local-agent daemon (packaged builds spawn it; dev uses dev-electron.sh).
let daemonProcess = null
let daemonURL = null
let daemonToken = null
const appWindowButtonPosition = { x: 29, y: 27 }
const authWindowButtonPosition = { x: 29, y: 20 }

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
          // Calibrated to the v4 design deliverable (SheJane 原型 v4.html):
          // the floating sidebar card sits at 12px margin + ~1px border +
          // 10px side padding, and the prototype's TrafficLights row adds
          // 6px left / 14px top inside that — lights group lands at
          // (12+1+10+6, 12+1+14) = (29, 27) from the window corner, clear
          // of the card's 14px corner radius.
          trafficLightPosition: appWindowButtonPosition,
        }
      : {}),
    icon: appIconPath,
    backgroundColor: '#FAF9F6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: localHostArgs(),
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
  // app-tray.png is 16×16, app-tray@2x.png is 32×32 — both sit next
  // to each other so Electron picks the right one for the current
  // display. No manual `.resize()` call (which used to mangle the
  // alpha edges by re-scaling already-pixelated 18px output).
  const trayIcon = nativeImage.createFromPath(trayIconPath)
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
          mainWindow.webContents.send('shejane:new-chat')
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

// The cloud API the main-process auth bridge (register/login/refresh) talks to.
// Must match the renderer's build-time VITE_API_BASE_URL or auth cookies bind to
// one origin while data calls hit another (silent session-refresh breakage).
// Packaged builds default to production; dev stays on the local API. An explicit
// env var still overrides either.
const PROD_API_BASE_URL = 'https://app.shejane.com'
function apiBaseURL() {
  return (
    process.env.SHEJANE_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    (app.isPackaged ? PROD_API_BASE_URL : 'http://localhost:8080')
  )
}

// ─── Bundled local-agent daemon ────────────────────────────────────────────
// Packaged builds spawn the frozen daemon (shipped via electron-builder
// extraResources) on a fresh loopback port with a one-time pairing token, then
// hand the URL+token to the renderer. In dev, scripts/dev-electron.sh does this
// instead, so main.cjs leaves the daemon alone (app.isPackaged === false).

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function daemonBinaryPath() {
  const exe = process.platform === 'win32' ? 'shejane-local-host.exe' : 'shejane-local-host'
  return path.join(process.resourcesPath, 'local-host', exe)
}

// Allowlist env forward (mirrors dev-electron.sh's `env -i`): the daemon never
// inherits platform-paid keys (Invariant #1). It proxies LLM + paid tools
// through the cloud API with the user's JWT, never a provider key.
function daemonEnv(extra) {
  const allow =
    process.platform === 'win32'
      ? ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'WINDIR', 'LANG', 'NUMBER_OF_PROCESSORS']
      : ['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE']
  const env = {}
  for (const key of allow) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }
  return { ...env, ...extra }
}

// Preload args so the renderer reliably gets the daemon URL+token (not reliant
// on env crossing the main→renderer process boundary). Empty in dev → preload
// falls back to the env that dev-electron.sh set.
function localHostArgs() {
  if (!daemonURL || !daemonToken) {
    return []
  }
  return [`--shejane-local-host-url=${daemonURL}`, `--shejane-local-host-token=${daemonToken}`]
}

async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/local/v1/health`)
      if (res.ok) {
        return true
      }
    } catch {
      // daemon not accepting connections yet — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

async function startBundledDaemon() {
  const port = await pickFreePort()
  daemonToken = crypto.randomBytes(32).toString('hex')
  daemonURL = `http://127.0.0.1:${port}`

  daemonProcess = spawn(daemonBinaryPath(), [], {
    env: daemonEnv({
      SHEJANE_LOCAL_HOST_ADDR: '127.0.0.1',
      SHEJANE_LOCAL_HOST_PORT: String(port),
      SHEJANE_LOCAL_HOST_TOKEN: daemonToken,
      SHEJANE_CLOUD_BASE_URL: apiBaseURL(),
      PYTHONUNBUFFERED: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  daemonProcess.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
  daemonProcess.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  daemonProcess.on('error', (err) => {
    dialog.showErrorBox(appName, `无法启动本地引擎：${err.message}`)
  })
  daemonProcess.on('exit', (code, signal) => {
    daemonProcess = null
    if (!app.isQuitting) {
      dialog.showErrorBox(appName, `本地引擎已退出（code=${code}, signal=${signal}），请重启应用。`)
    }
  })

  // Belt-and-suspenders: also expose via env (the dev handoff channel).
  process.env.SHEJANE_LOCAL_HOST_URL = daemonURL
  process.env.SHEJANE_LOCAL_HOST_TOKEN = daemonToken

  if (!(await waitForHealth(daemonURL))) {
    dialog.showErrorBox(appName, '本地引擎启动超时，请重启应用。')
  }
}

function stopBundledDaemon() {
  if (!daemonProcess) {
    return
  }
  const pid = daemonProcess.pid
  daemonProcess = null
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
    } else {
      // uvicorn traps SIGTERM (CLAUDE.md invariant #4) — force-kill.
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // already gone
  }
}

function registerAuthHandlers() {
  const auth = createElectronAuthHandlers({
    apiBaseURL: apiBaseURL(),
    cookies: session.defaultSession.cookies,
    fetchImpl: globalThis.fetch,
  })

  ipcMain.handle('shejane:auth-register', (_event, input) => authIPCResult(() => auth.register(input)))
  ipcMain.handle('shejane:auth-login', (_event, input) => authIPCResult(() => auth.login(input)))
  ipcMain.handle('shejane:auth-refresh', () => authIPCResult(() => auth.refresh()))
  ipcMain.handle('shejane:auth-logout', () => authIPCResult(() => auth.logout()))
}

function setMainWindowButtonPosition(position) {
  if (process.platform !== 'darwin' || !mainWindow || typeof mainWindow.setWindowButtonPosition !== 'function') {
    return false
  }
  const next =
    position === 'auth'
      ? authWindowButtonPosition
      : position === 'app'
        ? appWindowButtonPosition
        : appWindowButtonPosition
  mainWindow.setWindowButtonPosition(next)
  return true
}

app.whenReady().then(async () => {
  app.setName(appName)
  if (process.platform === 'darwin') {
    app.dock.setIcon(appIconPath)
  }
  registerAuthHandlers()
  // Packaged builds carry the frozen daemon and must start it themselves;
  // dev relies on scripts/dev-electron.sh (which also sets the env).
  if (app.isPackaged) {
    await startBundledDaemon()
  }
  createWindow()
  createTray()
  // Auto-update (packaged only). Downloads in the background and installs on
  // quit. Works on Windows unsigned; on macOS it no-ops until the app is signed
  // + notarized (Phase 4) — Gatekeeper rejects unsigned updates. Lazy-required
  // and fully guarded so a missing/erroring updater never blocks startup.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn('[updater] check failed:', err && err.message)
      })
    } catch (err) {
      console.warn('[updater] unavailable:', err && err.message)
    }
  }
})

// Marker that "real quit" was requested (vs. window-close). The close
// handler on the main window checks this flag to decide whether to hide
// to tray or actually let the close go through.
app.on('before-quit', () => {
  app.isQuitting = true
  stopBundledDaemon()
})

ipcMain.handle('shejane:set-locale', async (_event, locale) => {
  const normalized = locale === 'en' ? 'en' : 'zh'
  try {
    fs.mkdirSync(path.dirname(dockLangFile), { recursive: true })
    fs.writeFileSync(dockLangFile, normalized, 'utf8')
  } catch {
    // Best-effort: if disk write fails, dock label simply won't update next launch.
  }
  return normalized
})

ipcMain.handle('shejane:set-window-button-position', async (_event, position) => setMainWindowButtonPosition(position))

/** Surface a native OS notification. Returns `false` when the main
 *  window is currently focused — in that case the user can already see
 *  whatever just happened, so adding a notification on top is noise.
 *  Clicking the notification brings the main window forward. */
ipcMain.handle('shejane:notify', async (_event, payload) => {
  if (!Notification.isSupported()) {
    return false
  }
  const title = typeof payload?.title === 'string' ? payload.title : appName
  const body = typeof payload?.body === 'string' ? payload.body : ''
  if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) {
    return false
  }
  // `icon` is only honored on Windows + Linux; macOS pulls the icon
  // from the bundle's .icns. The branded .icns gets dropped into the
  // wrapper bundle by scripts/run-branded-electron.sh during dev.
  const notification = new Notification({ title, body, silent: false, icon: appIconPath })
  notification.on('click', () => {
    showOrCreateMainWindow()
  })
  notification.show()
  return true
})

ipcMain.handle('shejane:select-workspace-directory', async () => {
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

ipcMain.handle('shejane:open-file-with-default-app', async (_event, filePath) => {
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

ipcMain.handle('shejane:show-item-in-folder', async (_event, filePath) => {
  // Used by the message-bubble attachment chip's external-open
  // button (LOCAL files only — Finder / Explorer pops open with the
  // file highlighted). Returns 'ok' on success, an error string
  // otherwise. shell.showItemInFolder is sync + returns void so we
  // wrap defensively to match the openFileWithDefaultApp contract.
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'path required'
  }
  try {
    shell.showItemInFolder(filePath)
    return 'ok'
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
