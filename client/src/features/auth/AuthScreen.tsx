import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AuthPayload, JiandanAPI } from '@/shared/api/client'

export function AuthScreen({ api, onAuthed }: { api: JiandanAPI; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    try {
      const payload =
        mode === 'register'
          ? await api.register({ email, password, name: name || email.split('@')[0] })
          : await api.login({ email, password })
      await onAuthed(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败')
    }
  }

  return (
    <main className="auth-page">
      <Card className="auth-panel">
        <CardHeader>
          <div className="brand auth-brand">
            <span className="brand-mark">简</span>
            <div>
              <CardTitle>简单 Jiandan</CardTitle>
              <small>把复杂的工作，简单做完</small>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Tabs value={mode} onValueChange={(value) => setMode(value === 'login' ? 'login' : 'register')}>
            <TabsList className="auth-tabs grid w-full grid-cols-2">
              <TabsTrigger value="register">注册</TabsTrigger>
              <TabsTrigger value="login">登录</TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === 'register' ? (
            <label>
              名称
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="你的名字" />
            </label>
          ) : null}
          <label>
            邮箱
            <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
          </label>
          <label>
            密码
            <Input
              value={password}
              type="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <Button className="auth-submit" onClick={() => void submit()}>
            {mode === 'register' ? '创建账号' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
