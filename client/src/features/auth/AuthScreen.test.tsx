import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { AuthClient } from '@/shared/api/authClient'
import { AuthScreen } from './AuthScreen'

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

function makeAuthClient(): AuthClient {
  return {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
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
})
