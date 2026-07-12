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
const { installLocalRuntimeAuthorization } = require('./local-runtime-auth.cjs')
const {
  isPortConflictError,
  startRuntimeWithPortRetry,
  stopRuntimeProcess,
  waitForRuntimeReady,
  waitForRuntimeProcessClose,
} = require('./local-runtime-process.cjs')
const { appNameForLocale, desktopText, normalizeDesktopLocale } = require('./desktop-i18n.cjs')
const {
  configureApplicationMenuForPlatform,
  suppressWindowMenuForPlatform,
  trayIconConfigForPlatform,
  trayMenuTemplateForPlatform,
  windowMenuOptionsForPlatform,
} = require('./menu.cjs')
const { writeDesktopSmokeConfig } = require('./smoke-support.cjs')

const isDev = process.env.ELECTRON_DEV === 'true'
const dockLangFile =
  process.env.SHEJANE_DOCK_LANG_FILE || path.resolve(__dirname, '..', '..', '.tmp', 'dev', 'dock-lang')
function readDockLocale() {
  try {
    const value = fs.readFileSync(dockLangFile, 'utf8').trim()
    return normalizeDesktopLocale(value)
  } catch {
    return systemDesktopLocale()
  }
}
let currentLocale = readDockLocale()
function currentAppName() {
  return appNameForLocale(currentLocale)
}
function systemDesktopLocale() {
  try {
    if (typeof app.getLocale === 'function') {
      return normalizeDesktopLocale(app.getLocale())
    }
  } catch {
    // Fall through to the platform Intl locale when Electron has not initialized locale data yet.
  }
  return normalizeDesktopLocale(Intl.DateTimeFormat().resolvedOptions().locale)
}
const appIconPath = path.join(__dirname, 'assets/app-icon.png')
function isAllowedExternalURL(rawURL) {
  if (typeof rawURL !== 'string' || rawURL.length === 0) {
    return false
  }
  try {
    const parsed = new URL(rawURL)
    return ['http:', 'https:', 'shejane:'].includes(parsed.protocol)
  } catch {
    return false
  }
}
// Tray/menu-bar icons are platform-specific:
// - macOS wants a black + transparent template mask so the system can tint it.
// - Windows/Linux use a small full-color app icon so dark taskbars still read.
// Electron auto-loads matching `@2x` PNGs when they sit beside the base file.
function createTrayIcon(platform = process.platform) {
  const { filename, template } = trayIconConfigForPlatform(platform)
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', filename))
  if (template) {
    icon.setTemplateImage(true)
  }
  return icon
}

/** Module-scope references so tray/menu/notification handlers can find
 *  the main window without searching every time. */
let mainWindow = null
let tray = null
// Bundled local-agent daemon (packaged builds spawn it; dev uses dev-electron.sh).
let daemonProcess = null
let daemonURL = null
let daemonToken = null
let daemonReady = false
let daemonStopPromise = null
let runtimeSessionReady = false
let pendingDeepLinkURL = null
const appWindowButtonPosition = { x: 29, y: 27 }
const authWindowButtonPosition = { x: 29, y: 20 }

function createWindow() {
  if (!runtimeSessionReady) {
    return
  }
  const windowOptions = {
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: currentAppName(),
    ...windowMenuOptionsForPlatform(process.platform),
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
  suppressWindowMenuForPlatform(window, process.platform)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalURL(url)) {
      shell.openExternal(url)
    }
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
  window.webContents.once('did-finish-load', () => {
    if (pendingDeepLinkURL) {
      window.webContents.send('shejane:deep-link', pendingDeepLinkURL)
    }
  })
}

function showOrCreateMainWindow() {
  if (!runtimeSessionReady) {
    return
  }
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

function requestNewChat() {
  showOrCreateMainWindow()
  if (mainWindow) {
    mainWindow.webContents.send('shejane:new-chat')
  }
}

function handleDeepLink(rawURL) {
  if (!isAllowedExternalURL(rawURL)) {
    return
  }
  pendingDeepLinkURL = rawURL
  showOrCreateMainWindow()
  if (mainWindow) {
    mainWindow.webContents.send('shejane:deep-link', rawURL)
  }
}

function registerDeepLinkProtocol() {
  const scheme = 'shejane'
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])])
    return
  }
  app.setAsDefaultProtocolClient(scheme)
}

function configureApplicationMenu() {
  configureApplicationMenuForPlatform(Menu, process.platform, currentLocale, { onNewChat: requestNewChat })
}

function refreshTrayMenu() {
  if (!tray) {
    return
  }
  tray.setToolTip(currentAppName())
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuTemplateForPlatform(process.platform, currentLocale, {
        onShow: showOrCreateMainWindow,
        onNewChat: requestNewChat,
      }),
    ),
  )
}

function createTray() {
  const trayIcon = createTrayIcon(process.platform)
  tray = new Tray(trayIcon)
  refreshTrayMenu()
  // Single click on the tray icon: bring the window forward. Right-click
  // shows the context menu on its own (platform-default).
  tray.on('click', () => showOrCreateMainWindow())
}

function applyDesktopLocale(locale) {
  currentLocale = normalizeDesktopLocale(locale)
  app.setName(currentAppName())
  configureApplicationMenu()
  refreshTrayMenu()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(currentAppName())
  }
  return currentLocale
}

app.setName(currentAppName())
registerDeepLinkProtocol()
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find((arg) => typeof arg === 'string' && arg.startsWith('shejane://'))
    if (deepLink) {
      handleDeepLink(deepLink)
      return
    }
    showOrCreateMainWindow()
  })
}

app.on('open-url', (event, rawURL) => {
  event.preventDefault()
  handleDeepLink(rawURL)
})

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
// keep its token in Main, and expose only an authenticated desktop-session
// marker to the renderer. Dev still relies on scripts/dev-electron.sh to spawn.

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

function localRuntimeConnection() {
  return {
    baseURL:
      daemonURL ||
      process.env.SHEJANE_LOCAL_HOST_URL ||
      'http://127.0.0.1:17371',
    token: daemonToken || process.env.SHEJANE_LOCAL_HOST_TOKEN || '',
  }
}

// Renderer receives only the address and an opaque desktop-session marker.
// Electron's request session adds the private bearer token in Main.
function localHostArgs() {
  const connection = localRuntimeConnection()
  return [
    `--shejane-local-host-url=${connection.baseURL}`,
    ...(connection.token ? ['--shejane-local-host-session=desktop'] : []),
  ]
}

async function startBundledDaemon() {
  const port = await pickFreePort()
  daemonToken = crypto.randomBytes(32).toString('hex')
  daemonURL = `http://127.0.0.1:${port}`

  const child = spawn(daemonBinaryPath(), [], {
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
  daemonProcess = child
  child.runtimeClosed = false
  child.once('close', () => {
    child.runtimeClosed = true
  })
  let startupErrorOutput = ''
  child.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
  child.stderr.on('data', (chunk) => {
    startupErrorOutput = `${startupErrorOutput}${chunk}`.slice(-2048)
    if (isPortConflictError(startupErrorOutput)) {
      child.runtimePortConflict = true
    }
    process.stderr.write(`[daemon] ${chunk}`)
  })
  child.on('error', (err) => {
    console.error('[daemon] failed:', err && err.message)
  })
  child.on('exit', (code, signal) => {
    if (daemonProcess === child) {
      daemonProcess = null
    }
    const wasReady = daemonReady
    daemonReady = false
    runtimeSessionReady = false
    if (wasReady && !app.isQuitting) {
      dialog.showErrorBox(currentAppName(), desktopText(currentLocale, 'daemon.exited', { code, signal }))
    }
  })
  return child
}

async function stopBundledDaemon(child = daemonProcess) {
  daemonReady = false
  runtimeSessionReady = false
  if (!child) {
    daemonURL = null
    daemonToken = null
    return
  }
  if (child.exitCode === null) {
    await stopRuntimeProcess(child, {
      forceKill: async (pid) => {
        if (process.platform === 'win32') {
          try {
            await new Promise((resolve, reject) => {
              const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
              killer.once('error', reject)
              killer.once('exit', (code) => {
                if (code === 0) {
                  resolve()
                  return
                }
                reject(new Error(`taskkill exited with code ${code}`))
              })
            })
            return
          } catch (error) {
            console.error('[daemon] taskkill failed, falling back to process.kill:', error)
          }
        }
        process.kill(pid, 'SIGKILL')
      },
    })
  }
  await waitForRuntimeProcessClose(child)
  if (daemonProcess === child) {
    daemonProcess = null
  }
  daemonURL = null
  daemonToken = null
}

async function waitForRuntimeConnection(connection, ownedProcess, timeoutMs = 30000) {
  if (!ownedProcess) {
    return waitForRuntimeReady({
      baseURL: connection.baseURL,
      token: connection.token,
      timeoutMs,
    })
  }
  if (ownedProcess.exitCode !== null || daemonProcess !== ownedProcess) {
    return false
  }

  const readinessController = new AbortController()
  const readiness = waitForRuntimeReady({
    baseURL: connection.baseURL,
    token: connection.token,
    timeoutMs,
    signal: readinessController.signal,
  })
  let onStopped
  const stopped = new Promise((resolve) => {
    onStopped = () => resolve(false)
    ownedProcess.once('error', onStopped)
    ownedProcess.once('close', onStopped)
  })
  try {
    const ready = await Promise.race([readiness, stopped])
    return ready && ownedProcess.exitCode === null && daemonProcess === ownedProcess
  } finally {
    readinessController.abort()
    ownedProcess.off('error', onStopped)
    ownedProcess.off('close', onStopped)
  }
}

async function startBundledRuntime() {
  return startRuntimeWithPortRetry({
    start: startBundledDaemon,
    ready: (child, timeoutMs) => waitForRuntimeConnection(localRuntimeConnection(), child, timeoutMs),
    retryable: (child) => child.runtimePortConflict === true,
    stop: stopBundledDaemon,
  })
}

function registerAuthHandlers() {
  const auth = createElectronAuthHandlers({
    apiBaseURL: apiBaseURL(),
    cookies: session.defaultSession.cookies,
    fetchImpl: globalThis.fetch,
    locale: () => currentLocale,
  })

  ipcMain.handle('shejane:auth-register', (_event, input) => authIPCResult(() => auth.register(input), currentLocale))
  ipcMain.handle('shejane:auth-login', (_event, input) => authIPCResult(() => auth.login(input), currentLocale))
  ipcMain.handle('shejane:auth-refresh', () => authIPCResult(() => auth.refresh(), currentLocale))
  ipcMain.handle('shejane:auth-logout', () => authIPCResult(() => auth.logout(), currentLocale))
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
  app.setName(currentAppName())
  configureApplicationMenu()
  if (process.platform === 'darwin') {
    app.dock.setIcon(appIconPath)
  }
  try {
    registerAuthHandlers()
    // Packaged builds carry the frozen Runtime and start it themselves. Dev may
    // point at a separately managed Runtime through the SHEJANE_LOCAL_HOST_*
    // variables, but both paths must pass the same protocol handshake before
    // the renderer is created.
    const ownedProcess = app.isPackaged ? await startBundledRuntime() : null
    const runtimeConnection = localRuntimeConnection()
    const runtimeAvailable = app.isPackaged
      ? Boolean(ownedProcess)
      : Boolean(runtimeConnection.token) && await waitForRuntimeConnection(runtimeConnection, null)
    if (
      !runtimeConnection.token ||
      !runtimeAvailable
    ) {
      throw new Error(desktopText(currentLocale, 'daemon.startTimeout'))
    }
    daemonReady = Boolean(ownedProcess)
    runtimeSessionReady = true
    installLocalRuntimeAuthorization(session.defaultSession.webRequest, runtimeConnection)
    if (daemonProcess) {
      writeDesktopSmokeConfig({
        baseURL: runtimeConnection.baseURL,
        token: runtimeConnection.token,
        resourcesPath: process.resourcesPath,
        daemonPid: daemonProcess.pid || 0,
      })
    }
    createWindow()
    createTray()
  } catch (error) {
    let shutdownError = null
    try {
      await stopBundledDaemon()
    } catch (caughtShutdownError) {
      shutdownError = caughtShutdownError
      console.error('[daemon] shutdown after failed startup failed:', caughtShutdownError)
    }
    const startupMessage = error instanceof Error ? error.message : String(error)
    const message = shutdownError
      ? `${startupMessage}\n${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`
      : startupMessage
    dialog.showErrorBox(currentAppName(), desktopText(currentLocale, 'daemon.startFailed', { message }))
    if (!daemonProcess) {
      app.quit()
    }
    return
  }
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
app.on('before-quit', (event) => {
  app.isQuitting = true
  if (daemonStopPromise) {
    event.preventDefault()
    return
  }
  if (!daemonProcess) {
    return
  }
  event.preventDefault()
  daemonStopPromise = stopBundledDaemon().then(
    () => {
      daemonStopPromise = null
      app.quit()
    },
    (error) => {
      daemonStopPromise = null
      app.isQuitting = false
      console.error('[daemon] shutdown failed:', error)
      dialog.showErrorBox(
        currentAppName(),
        desktopText(currentLocale, 'daemon.startFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    },
  )
})

ipcMain.handle('shejane:set-locale', async (_event, locale) => {
  const normalized = applyDesktopLocale(locale)
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
  const title = typeof payload?.title === 'string' ? payload.title : currentAppName()
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
    title: desktopText(currentLocale, 'dialogs.selectWorkspaceTitle'),
    properties: ['openDirectory'],
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return undefined
  }
  return result.filePaths[0]
})

ipcMain.handle('shejane:open-external', async (_event, rawURL) => {
  if (!isAllowedExternalURL(rawURL)) {
    return 'unsupported url protocol'
  }
  try {
    await shell.openExternal(rawURL)
    return 'ok'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
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
