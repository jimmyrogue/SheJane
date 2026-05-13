import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { AuthPayload, JiandanAPI } from '@/shared/api/client'

export function AuthScreen({ api, onAuthed }: { api: JiandanAPI; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const pageClassName = window.jiandanDesktop ? 'auth-page electron-auth-page' : 'auth-page'
  const isRegistering = mode === 'register'
  const title = isRegistering ? '创建简单账号' : '欢迎回来'
  const subtitle = isRegistering ? '开始把复杂的工作，简单做完' : '登录后继续你的本地优先工作流'

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
    <main className={pageClassName}>
      <Card className="auth-panel">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="logo auth-logo">简</span>
            <div className="auth-heading">
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>

          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {isRegistering ? (
              <label className="auth-field">
                <span>名称</span>
                <Input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="你的名字" />
              </label>
            ) : null}
            <label className="auth-field">
              <span>邮箱</span>
              <Input
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="auth-field">
              <span>密码</span>
              <Input
                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                value={password}
                type="password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isRegistering ? '至少 8 位' : '输入密码'}
              />
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <Button className="auth-submit" type="submit">
              {isRegistering ? '创建账号' : '登录'}
            </Button>
          </form>

          <div className="auth-divider" aria-hidden="true">
            <span />
          </div>

          <p className="auth-switch">
            <span>{isRegistering ? '已有账号？' : '还没有账号？'}</span>
            <button type="button" onClick={() => setMode(isRegistering ? 'login' : 'register')}>
              {isRegistering ? '登录' : '注册'}
            </button>
          </p>
        </div>
      </Card>
    </main>
  )
}
