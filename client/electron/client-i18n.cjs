const messages = require('../shared/client-i18n.json')

function normalizeDesktopLocale(locale) {
  const value = String(locale || '').toLowerCase()
  return value === 'en' || value.startsWith('en-') ? 'en' : 'zh'
}

function desktopMessages(locale) {
  return messages[normalizeDesktopLocale(locale)] || messages.zh
}

function interpolate(template, params = {}) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(params[key] ?? ''))
}

function desktopText(locale, keyPath, params = {}) {
  const value = keyPath.split('.').reduce((node, key) => node?.[key], desktopMessages(locale))
  return typeof value === 'string' ? interpolate(value, params) : keyPath
}

function appNameForLocale(locale) {
  return desktopMessages(locale).appName
}

function desktopLabels(locale) {
  const appName = appNameForLocale(locale)
  const labels = desktopMessages(locale).menu
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key, interpolate(value, { appName })]),
  )
}

module.exports = {
  appNameForLocale,
  desktopLabels,
  desktopMessages,
  desktopText,
  normalizeDesktopLocale,
}
