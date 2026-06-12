function normalizeDesktopLocale(locale) {
  return locale === 'en' ? 'en' : 'zh'
}

function appNameForLocale(locale) {
  return normalizeDesktopLocale(locale) === 'en' ? 'SheJane' : '石间'
}

function desktopLabels(locale) {
  const normalized = normalizeDesktopLocale(locale)
  const appName = appNameForLocale(normalized)
  if (normalized === 'en') {
    return {
      appName,
      about: `About ${appName}`,
      close: 'Close Window',
      copy: 'Copy',
      cut: 'Cut',
      edit: 'Edit',
      forceReload: 'Force Reload',
      hide: `Hide ${appName}`,
      hideOthers: 'Hide Others',
      minimize: 'Minimize',
      newChat: 'New Chat',
      paste: 'Paste',
      quit: `Quit ${appName}`,
      redo: 'Redo',
      reload: 'Reload',
      resetZoom: 'Actual Size',
      selectAll: 'Select All',
      show: 'Show',
      showAll: 'Show All',
      toggleDevTools: 'Developer Tools',
      undo: 'Undo',
      view: 'View',
      window: 'Window',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
    }
  }
  return {
    appName,
    about: `关于${appName}`,
    close: '关闭窗口',
    copy: '复制',
    cut: '剪切',
    edit: '编辑',
    forceReload: '强制重新加载',
    hide: `隐藏${appName}`,
    hideOthers: '隐藏其他',
    minimize: '最小化',
    newChat: '新建对话',
    paste: '粘贴',
    quit: `退出${appName}`,
    redo: '重做',
    reload: '重新加载',
    resetZoom: '实际大小',
    selectAll: '全选',
    show: '显示主窗口',
    showAll: '全部显示',
    toggleDevTools: '开发者工具',
    undo: '撤销',
    view: '显示',
    window: '窗口',
    zoomIn: '放大',
    zoomOut: '缩小',
  }
}

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
  normalizeDesktopLocale,
  suppressWindowMenuForPlatform,
  trayIconConfigForPlatform,
  trayMenuTemplateForPlatform,
  windowMenuOptionsForPlatform,
}
