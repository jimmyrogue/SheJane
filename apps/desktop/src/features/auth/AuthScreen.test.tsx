import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { AuthClient } from '@/shared/api/authClient'
import type { AuthPayload } from '@/shared/api/client'
import { AuthScreen } from './AuthScreen'

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
  window.shejaneDesktop = undefined
})

function makeAuthClient(): AuthClient {
  return {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  }
}

function makeAuthPayload(email = 'me@example.com'): AuthPayload {
  return {
    access_token: 'access-token',
    user: {
      id: 'user-1',
      email,
      name: 'Me',
      role: 'user',
      status: 'active',
    },
  }
}

describe('AuthScreen password reset', () => {
  it('sends a reset email from the forgot flow', async () => {
    const onRequestPasswordReset = vi.fn(async () => {})
    render(
      <I18nProvider>
        <AuthScreen
          authClient={makeAuthClient()}
          onAuthed={vi.fn()}
          onRequestPasswordReset={onRequestPasswordReset}
          onConfirmPasswordReset={vi.fn()}
        />
      </I18nProvider>,
    )

    // register → login (the "登录" mode link), then open the forgot flow.
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }))

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送重置链接' }))

    await waitFor(() => expect(onRequestPasswordReset).toHaveBeenCalledWith('me@example.com'))
    expect(await screen.findByText(/重置链接已发出/)).toBeInTheDocument()
  })

  it('opens in reset mode from a token in the URL and confirms a new password', async () => {
    window.history.pushState({}, '', '/reset?token=tok-123')
    const onConfirmPasswordReset = vi.fn(async () => {})
    render(
      <I18nProvider>
        <AuthScreen
          authClient={makeAuthClient()}
          onAuthed={vi.fn()}
          onRequestPasswordReset={vi.fn()}
          onConfirmPasswordReset={onConfirmPasswordReset}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('heading', { name: '设置新密码' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))

    await waitFor(() => expect(onConfirmPasswordReset).toHaveBeenCalledWith('tok-123', 'newpass123'))
  })

  it('does not show the forgot link while registering', () => {
    render(
      <I18nProvider>
        <AuthScreen authClient={makeAuthClient()} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('button', { name: '忘记密码？' })).not.toBeInTheDocument()
  })

  it('does not show reset-email success when the request handler is not wired', async () => {
    render(
      <I18nProvider>
        <AuthScreen authClient={makeAuthClient()} onAuthed={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送重置链接' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('重置密码 暂不可用。')
    expect(screen.queryByText(/重置链接已发出/)).not.toBeInTheDocument()
  })

  it('does not show reset success when the confirm handler is not wired', async () => {
    window.history.pushState({}, '', '/reset?token=tok-123')
    render(
      <I18nProvider>
        <AuthScreen authClient={makeAuthClient()} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('重置密码 暂不可用。')
    expect(screen.queryByText(/密码已重置/)).not.toBeInTheDocument()
  })

  it('uses native desktop traffic lights instead of rendering fake ones', async () => {
    const setWindowButtonPosition = vi.fn(async () => true)
    window.shejaneDesktop = {
      platform: 'darwin',
      setWindowButtonPosition,
    }

    const { container, unmount } = render(
      <I18nProvider>
        <AuthScreen authClient={makeAuthClient()} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    expect(container.querySelector('.auth-window-lights')).toBeNull()
    await waitFor(() => expect(setWindowButtonPosition).toHaveBeenCalledWith('auth'))

    unmount()

    expect(setWindowButtonPosition).toHaveBeenLastCalledWith('app')
  })

  it('tabs from login email directly to password before forgot-password action', () => {
    const { container } = render(
      <I18nProvider>
        <AuthScreen authClient={makeAuthClient()} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    const email = screen.getByLabelText('邮箱')
    const password = screen.getByLabelText('密码')
    const forgot = screen.getByRole('button', { name: '忘记密码？' })
    const form = container.querySelector('.auth-form')
    expect(form).not.toBeNull()

    const focusable = Array.from(form!.querySelectorAll<HTMLElement>('input, button, a[href], textarea, select, [tabindex]'))
      .filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0)

    expect(focusable.indexOf(password)).toBe(focusable.indexOf(email) + 1)
    expect(focusable.indexOf(forgot)).toBeGreaterThan(focusable.indexOf(password))

    email.focus()
    fireEvent.keyDown(email, { key: 'Tab', code: 'Tab' })

    expect(document.activeElement).toBe(password)
  })

  it('submits login with Enter from the password field', async () => {
    const payload = makeAuthPayload()
    const authClient: AuthClient = {
      ...makeAuthClient(),
      login: vi.fn(async () => payload),
    }
    const onAuthed = vi.fn(async () => {})
    render(
      <I18nProvider>
        <AuthScreen authClient={authClient} onAuthed={onAuthed} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: payload.user.email } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.keyDown(screen.getByLabelText('密码'), { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(authClient.login).toHaveBeenCalledWith({ email: payload.user.email, password: 'secret123' }))
    expect(onAuthed).toHaveBeenCalledWith(payload)
  })

  it('shows field errors and does not register when required registration fields are empty', async () => {
    const authClient = makeAuthClient()
    render(
      <I18nProvider>
        <AuthScreen authClient={authClient} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))

    expect(await screen.findByText('请输入名称')).toBeInTheDocument()
    expect(screen.getByText('请输入邮箱')).toBeInTheDocument()
    expect(screen.getByText('请输入密码')).toBeInTheDocument()
    expect(authClient.register).not.toHaveBeenCalled()
  })

  it('validates login email format before calling the API', async () => {
    const authClient = makeAuthClient()
    render(
      <I18nProvider>
        <AuthScreen authClient={authClient} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('请输入有效的邮箱地址')).toBeInTheDocument()
    expect(authClient.login).not.toHaveBeenCalled()
  })

  it('requires at least 8 characters before registering', async () => {
    const authClient = makeAuthClient()
    render(
      <I18nProvider>
        <AuthScreen authClient={authClient} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Me' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))

    expect(await screen.findByText('密码至少需要 8 位')).toBeInTheDocument()
    expect(authClient.register).not.toHaveBeenCalled()
  })

  it('requires a password before login submit', async () => {
    const authClient = makeAuthClient()
    render(
      <I18nProvider>
        <AuthScreen authClient={authClient} onAuthed={vi.fn()} onRequestPasswordReset={vi.fn()} onConfirmPasswordReset={vi.fn()} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@example.com' } })
    fireEvent.keyDown(screen.getByLabelText('密码'), { key: 'Enter', code: 'Enter' })

    expect(await screen.findByText('请输入密码')).toBeInTheDocument()
    expect(authClient.login).not.toHaveBeenCalled()
  })

  it('requires at least 8 characters when setting a new password', async () => {
    window.history.pushState({}, '', '/reset?token=tok-123')
    const onConfirmPasswordReset = vi.fn(async () => {})
    render(
      <I18nProvider>
        <AuthScreen
          authClient={makeAuthClient()}
          onAuthed={vi.fn()}
          onRequestPasswordReset={vi.fn()}
          onConfirmPasswordReset={onConfirmPasswordReset}
        />
      </I18nProvider>,
    )

    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))

    expect(await screen.findByText('密码至少需要 8 位')).toBeInTheDocument()
    expect(onConfirmPasswordReset).not.toHaveBeenCalled()
  })
})
