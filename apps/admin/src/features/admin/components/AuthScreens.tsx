import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import LogOut from 'lucide-react/dist/esm/icons/log-out'
import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type AdminAPI, type AuthPayload } from '@/shared/api/client'
import { BrandBlock } from './brand'

export function LoadingScreen() {
  return (
    <main className="admin-auth-screen">
      <Card className="admin-auth-card w-full max-w-sm">
        <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在检查登录状态...
        </CardContent>
      </Card>
    </main>
  )
}

export function AuthScreen({ api, onAuthed }: { api: AdminAPI; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function login() {
    setError('')
    try {
      await onAuthed(await api.login({ email, password }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败')
    }
  }

  async function register() {
    setError('')
    try {
      await onAuthed(await api.register({ email, password, name: name || email.split('@')[0] }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建账号失败')
    }
  }

  return (
    <main className="admin-auth-screen">
      <Card className="admin-auth-card w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <BrandBlock subtitle="运营、用户、额度和模型状态" />
          <div>
            <CardTitle>管理员登录</CardTitle>
            <CardDescription>使用配置在 ADMIN_EMAILS 中的账号进入独立后台。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void login()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="admin-name">名称</Label>
              <Input id="admin-name" value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="首次创建管理员时填写" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin-email">邮箱</Label>
              <Input id="admin-email" value={email} type="email" autoComplete="email" onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin-password">密码</Label>
              <Input id="admin-password" value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" />
            </div>
            {error ? (
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className="flex-1" type="submit">
                登录
              </Button>
              <Button className="flex-1" type="button" variant="outline" onClick={() => void register()}>
                创建账号
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

export function AccessDeniedScreen({ auth, onLogout }: { auth: AuthPayload; onLogout: () => Promise<void> }) {
  return (
    <main className="admin-auth-screen">
      <Card className="admin-auth-card w-full max-w-md">
        <CardHeader className="space-y-4">
          <BrandBlock subtitle={auth.user.email} />
          <div>
            <CardTitle>无管理员权限</CardTitle>
            <CardDescription>当前账号不是管理员。请使用配置在 ADMIN_EMAILS 中的账号登录。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void onLogout()}>
            <LogOut className="size-4" />
            退出登录
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
