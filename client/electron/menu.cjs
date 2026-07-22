const { appNameForLocale, desktopLabels, desktopText, normalizeDesktopLocale } = require('./client-i18n.cjs')

function applicationMenuTemplateForPlatform(platform, locale, actions = {}) {
  if (platform !== 'darwin') {
    return null
  }
  const labels = desktopLabels(locale)
  return [
    {
      label: labels.appName,
      submenu: [
        { label: labels.about, role: 'about' },
        { label: labels.checkForUpdates, click: actions.onCheckForUpdates },
        { type: 'separator' },
        { label: labels.newChat, accelerator: 'Cmd+N', click: actions.onNewChat },
        { type: 'separator' },
        { label: labels.hide, accelerator: 'Cmd+H', role: 'hide' },
        { label: labels.hideOthers, accelerator: 'Option+Cmd+H', role: 'hideOthers' },
        { label: labels.showAll, role: 'unhide' },
        { type: 'separator' },
        { label: labels.quit, accelerator: 'Cmd+Q', role: 'quit' },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, accelerator: 'Cmd+Z', role: 'undo' },
        { label: labels.redo, accelerator: 'Shift+Cmd+Z', role: 'redo' },
        { type: 'separator' },
        { label: labels.cut, accelerator: 'Cmd+X', role: 'cut' },
        { label: labels.copy, accelerator: 'Cmd+C', role: 'copy' },
        { label: labels.paste, accelerator: 'Cmd+V', role: 'paste' },
        { label: labels.selectAll, accelerator: 'Cmd+A', role: 'selectAll' },
      ],
    },
    {
      label: labels.view,
      submenu: [
        { label: labels.reload, accelerator: 'Cmd+R', role: 'reload' },
        { label: labels.forceReload, accelerator: 'Shift+Cmd+R', role: 'forceReload' },
        { label: labels.toggleDevTools, accelerator: 'Alt+Cmd+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: labels.resetZoom, accelerator: 'Cmd+0', role: 'resetZoom' },
        { label: labels.zoomIn, accelerator: 'Cmd+Plus', role: 'zoomIn' },
        { label: labels.zoomOut, accelerator: 'Cmd+-', role: 'zoomOut' },
      ],
    },
    {
      label: labels.window,
      submenu: [
        { label: labels.minimize, accelerator: 'Cmd+M', role: 'minimize' },
        { label: labels.close, accelerator: 'Cmd+W', role: 'close' },
      ],
    },
  ]
}

function trayMenuTemplateForPlatform(platform, locale, actions = {}) {
  const labels = desktopLabels(locale)
  return [
    {
      label: labels.show,
      click: actions.onShow,
    },
    {
      label: labels.newChat,
      accelerator: platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
      click: actions.onNewChat,
    },
    { type: 'separator' },
    { label: labels.quit, role: 'quit' },
  ]
}

function fileContextMenuTemplate(platform, locale, canPreview, actions = {}) {
  return [
    {
      id: 'preview',
      label: desktopText(locale, 'fileContext.preview'),
      enabled: Boolean(canPreview),
      click: actions.onPreview,
    },
    { id: 'open', label: desktopText(locale, 'fileContext.open'), click: actions.onOpen },
    { id: 'save', label: desktopText(locale, 'fileContext.save'), click: actions.onSave },
    { type: 'separator' },
    {
      id: 'reveal',
      label: desktopText(locale, platform === 'darwin' ? 'fileContext.revealFinder' : 'fileContext.revealFolder'),
      click: actions.onReveal,
    },
  ]
}

function windowMenuOptionsForPlatform(platform) {
  return platform === 'darwin' ? {} : { autoHideMenuBar: true }
}

function trayIconConfigForPlatform(platform) {
  return platform === 'darwin'
    ? { filename: 'app-tray.png', template: true }
    : { filename: 'app-tray-win.png', template: false }
}

function configureApplicationMenuForPlatform(Menu, platform, locale, actions = {}) {
  const template = applicationMenuTemplateForPlatform(platform, locale, actions)
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null)
}

function suppressWindowMenuForPlatform(window, platform) {
  if (platform === 'darwin') {
    return
  }
  if (typeof window.setAutoHideMenuBar === 'function') {
    window.setAutoHideMenuBar(true)
  }
  if (typeof window.setMenuBarVisibility === 'function') {
    window.setMenuBarVisibility(false)
  }
  if (typeof window.removeMenu === 'function') {
    window.removeMenu()
  }
}

module.exports = {
  appNameForLocale,
  applicationMenuTemplateForPlatform,
  configureApplicationMenuForPlatform,
  desktopLabels,
  desktopText,
  fileContextMenuTemplate,
  normalizeDesktopLocale,
  suppressWindowMenuForPlatform,
  trayIconConfigForPlatform,
  trayMenuTemplateForPlatform,
  windowMenuOptionsForPlatform,
}
