const REFRESH_COOKIE_NAME = 'shejane_refresh'
const { desktopText } = require('./desktop-i18n.cjs')

function createElectronAuthHandlers({ apiBaseURL = 'http://localhost:8080', cookies, fetchImpl = globalThis.fetch, locale = 'zh' } = {}) {
  if (!cookies) {
    throw new Error('Electron cookie store is required')
  }
  if (!fetchImpl) {
    throw new Error('fetch is required')
  }
  const baseURL = normalizeBaseURL(apiBaseURL)

  return {
    register: (input) => authRequest({ baseURL, cookies, fetchImpl, locale: resolveLocale(locale), path: '/api/v1/auth/register', body: input }),
    login: (input) => authRequest({ baseURL, cookies, fetchImpl, locale: resolveLocale(locale), path: '/api/v1/auth/login', body: input }),
    refresh: () => authRequest({ baseURL, cookies, fetchImpl, locale: resolveLocale(locale), path: '/api/v1/auth/refresh', body: {}, includeCookie: true }),
    logout: async () => {
      try {
        await authRequest({ baseURL, cookies, fetchImpl, locale: resolveLocale(locale), path: '/api/v1/auth/logout', body: {}, includeCookie: true })
      } finally {
        await clearRefreshCookie(cookies, baseURL)
      }
    },
  }
}

async function authIPCResult(action, locale = 'zh') {
  try {
    return { ok: true, data: await action() }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : desktopText(locale, 'errors.requestFailed'),
    }
  }
}

function unwrapAuthIPCResult(result, locale = 'zh') {
  if (result?.ok === false) {
    throw new Error(result.error || desktopText(locale, 'errors.requestFailed'))
  }
  if (result?.ok === true) {
    return result.data
  }
  return result
}

async function authRequest({ baseURL, cookies, fetchImpl, locale = 'zh', path, body, includeCookie = false }) {
  const headers = {
    'Content-Type': 'application/json',
  }
  if (includeCookie) {
    const cookie = await refreshCookieHeader(cookies, baseURL)
    if (cookie) {
      headers.Cookie = cookie
    }
  }

  const response = await fetchImpl(`${baseURL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
  await persistRefreshCookie(response, cookies, baseURL)
  return decodeAPIResponse(response, locale)
}

async function decodeAPIResponse(response, locale = 'zh') {
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  if (!response.ok) {
    throw new Error(body?.message || `HTTP ${response.status}`)
  }
  if (body?.code !== 0) {
    throw new Error(body?.message || desktopText(locale, 'errors.requestFailed'))
  }
  return body.data
}

async function persistRefreshCookie(response, cookies, baseURL) {
  const setCookies = responseSetCookieHeaders(response)
  for (const header of setCookies) {
    const parsed = parseSetCookieHeader(header)
    if (parsed?.name !== REFRESH_COOKIE_NAME) {
      continue
    }
    if (!parsed.value || parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      await clearRefreshCookie(cookies, baseURL)
      continue
    }

    const cookie = {
      url: cookieURL(baseURL),
      name: REFRESH_COOKIE_NAME,
      value: parsed.value,
      path: parsed.path || '/',
      httpOnly: parsed.httpOnly,
      secure: parsed.secure,
      sameSite: parsed.sameSite || 'lax',
    }
    const expirationDate = cookieExpirationDate(parsed)
    if (expirationDate !== undefined) {
      cookie.expirationDate = expirationDate
    }
    await cookies.set(cookie)
  }
}

function responseSetCookieHeaders(response) {
  if (typeof response.headers?.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }
  const header = response.headers?.get?.('set-cookie')
  return header ? splitSetCookieHeader(header) : []
}

function splitSetCookieHeader(header) {
  return header.split(/,(?=\s*[^;,=\s]+=)/).map((value) => value.trim()).filter(Boolean)
}

function parseSetCookieHeader(header) {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim())
  const separator = pair.indexOf('=')
  if (separator <= 0) {
    return undefined
  }

  const parsed = {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    httpOnly: false,
    secure: false,
  }

  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.split('=')
    const name = rawName.trim().toLowerCase()
    const value = rawValue.join('=').trim()

    if (name === 'path') {
      parsed.path = value || '/'
    } else if (name === 'max-age') {
      const maxAge = Number.parseInt(value, 10)
      if (!Number.isNaN(maxAge)) {
        parsed.maxAge = maxAge
      }
    } else if (name === 'expires') {
      const expiresAt = Date.parse(value)
      if (!Number.isNaN(expiresAt)) {
        parsed.expiresAt = expiresAt
      }
    } else if (name === 'httponly') {
      parsed.httpOnly = true
    } else if (name === 'secure') {
      parsed.secure = true
    } else if (name === 'samesite') {
      parsed.sameSite = normalizeSameSite(value)
    }
  }

  return parsed
}

function normalizeSameSite(value) {
  const sameSite = value.trim().toLowerCase()
  if (sameSite === 'strict') {
    return 'strict'
  }
  if (sameSite === 'none' || sameSite === 'no_restriction') {
    return 'no_restriction'
  }
  return 'lax'
}

function cookieExpirationDate(parsed) {
  if (parsed.maxAge !== undefined) {
    return Math.floor(Date.now() / 1000) + parsed.maxAge
  }
  if (parsed.expiresAt !== undefined) {
    return Math.floor(parsed.expiresAt / 1000)
  }
  return undefined
}

async function refreshCookieHeader(cookies, baseURL) {
  const stored = await cookies.get({ url: cookieURL(baseURL), name: REFRESH_COOKIE_NAME })
  const cookie = stored[0]
  if (!cookie?.value) {
    return ''
  }
  return `${REFRESH_COOKIE_NAME}=${cookie.value}`
}

async function clearRefreshCookie(cookies, baseURL) {
  await cookies.remove(cookieURL(baseURL), REFRESH_COOKIE_NAME)
}

function normalizeBaseURL(value) {
  return String(value || 'http://localhost:8080').replace(/\/+$/, '')
}

function cookieURL(baseURL) {
  return `${new URL(baseURL).origin}/`
}

function resolveLocale(locale) {
  return typeof locale === 'function' ? locale() : locale
}

module.exports = {
  REFRESH_COOKIE_NAME,
  authIPCResult,
  clearRefreshCookie,
  createElectronAuthHandlers,
  parseSetCookieHeader,
  refreshCookieHeader,
  unwrapAuthIPCResult,
}
