import { useEffect, useMemo, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AccessDeniedScreen, AuthScreen, LoadingScreen } from '@/features/admin/components/AuthScreens'
import { AdminDashboard } from '@/features/admin/dashboard/AdminDashboard'
import { AdminAPI, type AuthPayload } from '@/shared/api/client'

export function App() {
  const api = useMemo(() => new AdminAPI(), [])
  const [auth, setAuth] = useState<AuthPayload | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    api.setTokenRefresher(async () => {
      try {
        const payload = await api.refresh()
        api.setAccessToken(payload.access_token)
        return payload.access_token
      } catch {
        setAuth(null)
        return null
      }
    })
  }, [api])

  useEffect(() => {
    api
      .refresh()
      .then((payload) => {
        api.setAccessToken(payload.access_token)
        setAuth(payload)
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true))
  }, [api])

  async function handleLogin(payload: AuthPayload) {
    api.setAccessToken(payload.access_token)
    setAuth(payload)
  }

  async function logout() {
    await api.logout()
    setAuth(null)
  }

  return (
    <TooltipProvider>
      {!authChecked ? (
        <LoadingScreen />
      ) : !auth ? (
        <AuthScreen api={api} onAuthed={handleLogin} />
      ) : auth.user.role !== 'admin' ? (
        <AccessDeniedScreen auth={auth} onLogout={logout} />
      ) : (
        <AdminDashboard api={api} auth={auth} onLogout={logout} />
      )}
    </TooltipProvider>
  )
}
