import { useState, type ReactNode } from 'react'
import { IconArrowRight, IconCheck, IconEye, IconEyeOff, IconLock, IconMail, IconUser } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { AuthClient } from '@/shared/api/authClient'
import type { AuthPayload } from '@/shared/api/client'
import { appLogoURL } from '@/shared/assets/logo'
import { LocaleSwitcher, useI18n, type Translator } from '@/shared/i18n/i18n'

type AuthMode = 'login' | 'register' | 'forgot' | 'reset'

export function AuthScreen({
  authClient,
  onAuthed,
  onRequestPasswordReset,
  onConfirmPasswordReset,
}: {
  authClient: AuthClient
  onAuthed: (payload: AuthPayload) => Promise<void>
  /** Send a password-reset email. Unauthenticated; wired from App → api. */
  onRequestPasswordReset?: (email: string) => Promise<void>
  /** Set a new password from a reset token. Wired from App → api. */
  onConfirmPasswordReset?: (token: string, password: string) => Promise<void>
}) {
  const { t } = useI18n()
  const resetToken = readResetToken()
  const [mode, setMode] = useState<AuthMode>(resetToken ? 'reset' : 'register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [acceptedTerms, setAcceptedTerms] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const pageClassName = window.shejaneDesktop ? 'auth-page electron-auth-page' : 'auth-page'
  const isRegistering = mode === 'register'
  const isForgot = mode === 'forgot'
  const isReset = mode === 'reset'
  const isPasswordFlow = isForgot || isReset
  const emailLooksValid = isValidEmail(email)

  function switchMode(next: AuthMode) {
    setError('')
    setInfo('')
    setPassword('')
    setMode(next)
  }

  async function submit() {
    setError('')
    if (isRegistering && !acceptedTerms) {
      setError(t('auth.error.acceptTerms'))
      return
    }
    setIsSubmitting(true)
    try {
      if (isForgot) {
        await onRequestPasswordReset?.(email)
        setInfo(t('auth.forgot.sent'))
        return
      }
      if (isReset) {
        if (!resetToken) {
          setError(t('auth.reset.invalidToken'))
          return
        }
        await onConfirmPasswordReset?.(resetToken, password)
        setInfo(t('auth.reset.success'))
        setMode('login')
        return
      }
      const payload = isRegistering
        ? await authClient.register({ email, password, name: name || email.split('@')[0] })
        : await authClient.login({ email, password })
      await onAuthed(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('auth.error.failed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className={pageClassName}>
      <div className="window-drag-layer" aria-hidden="true" />
      <Card className="auth-panel">
        <div className="auth-titlebar">
          <LocaleSwitcher className="auth-language-switch" />
        </div>

        <div className={isRegistering ? 'auth-layout register' : 'auth-layout login'}>
          <section className="auth-brand-panel" aria-label={t('app.productName')}>
            <div className="auth-wordmark">
              <span className="auth-wordmark-mark">
                <img src={appLogoURL} alt="" aria-hidden="true" />
              </span>
              <span>{t('app.productName')}</span>
            </div>
          </section>

          <section className="auth-form-panel" aria-label={isRegistering ? t('auth.panelLabel.register') : t('auth.panelLabel.login')}>
            <div className="auth-mode-link">
              {isPasswordFlow ? (
                <button type="button" onClick={() => switchMode('login')}>
                  {t('auth.forgot.backToLogin')}
                </button>
              ) : (
                <>
                  <span>{isRegistering ? t('auth.mode.hasAccount') : t('auth.mode.noAccount')}</span>
                  <button type="button" onClick={() => switchMode(isRegistering ? 'login' : 'register')}>
                    {isRegistering ? t('auth.mode.signIn') : t('auth.mode.create')}
                  </button>
                </>
              )}
            </div>

            <div className="auth-form-wrap">
              <div className="auth-form-heading">
                <h1>{authHeading(mode, t)}</h1>
                <p>{authSubheading(mode, t)}</p>
              </div>

              <form
                className="auth-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submit()
                }}
              >
                {isRegistering ? (
                  <AuthField id="auth-name" label={t('auth.name.label')} icon={<IconUser size={14} />}>
                    <Input
                      id="auth-name"
                      aria-label={t('auth.name.label')}
                      autoComplete="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t('auth.name.placeholder')}
                    />
                  </AuthField>
                ) : null}

                {!isReset ? (
                  <AuthField
                    id="auth-email"
                    label={t('auth.email.label')}
                    icon={<IconMail size={14} />}
                    success={Boolean(email) && emailLooksValid}
                  >
                    <Input
                      id="auth-email"
                      aria-label={t('auth.email.label')}
                      autoComplete="email"
                      inputMode="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={t('auth.email.placeholder')}
                    />
                  </AuthField>
                ) : null}

                {!isForgot ? (
                  <AuthField
                    id="auth-password"
                    label={isReset ? t('auth.reset.newPassword') : t('auth.password.label')}
                    icon={<IconLock size={14} />}
                    action={
                      mode === 'login' ? (
                        <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>
                          {t('auth.password.forgot')}
                        </button>
                      ) : undefined
                    }
                    control={
                      <button
                        className="auth-input-action"
                        type="button"
                        aria-label={showPassword ? t('auth.password.hide') : t('auth.password.show')}
                        onClick={() => setShowPassword((current) => !current)}
                      >
                        {showPassword ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                      </button>
                    }
                  >
                    <Input
                      id="auth-password"
                      aria-label={isReset ? t('auth.reset.newPassword') : t('auth.password.label')}
                      autoComplete={isRegistering || isReset ? 'new-password' : 'current-password'}
                      value={password}
                      type={showPassword ? 'text' : 'password'}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={
                        isReset
                          ? t('auth.reset.newPasswordPlaceholder')
                          : isRegistering
                            ? t('auth.password.placeholder.register')
                            : t('auth.password.placeholder.login')
                      }
                    />
                  </AuthField>
                ) : null}

                {isRegistering || mode === 'login' ? (
                  <div className={isRegistering ? 'auth-checkline terms' : 'auth-checkline'}>
                    <button
                      type="button"
                      className={isRegistering ? checkboxClass(acceptedTerms) : checkboxClass(rememberDevice)}
                      aria-pressed={isRegistering ? acceptedTerms : rememberDevice}
                      onClick={() => {
                        if (isRegistering) {
                          setAcceptedTerms((current) => !current)
                        } else {
                          setRememberDevice((current) => !current)
                        }
                      }}
                    >
                      {(isRegistering ? acceptedTerms : rememberDevice) ? <IconCheck size={10} /> : null}
                    </button>
                    <span>
                      {isRegistering ? (
                        <>
                          {t('auth.terms.prefix')}
                          <a href="#terms">{t('auth.termsLink')}</a>
                          {t('auth.terms.middle')}
                          <a href="#privacy">{t('auth.privacyLink')}</a>
                          {t('auth.terms.suffix')}
                        </>
                      ) : (
                        t('auth.rememberDevice')
                      )}
                    </span>
                  </div>
                ) : null}

                {info ? (
                  <p className="auth-info" role="status" aria-live="polite">
                    {info}
                  </p>
                ) : null}

                {error ? (
                  <p className="auth-error" role="alert" aria-live="polite">
                    {error}
                  </p>
                ) : null}

                <Button className="auth-submit" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                  {authSubmitLabel(mode, isSubmitting, t)}
                  <IconArrowRight size={14} />
                </Button>
              </form>
            </div>

            <AuthFooter />
          </section>
        </div>
      </Card>
    </main>
  )
}

function AuthField({
  id,
  label,
  icon,
  action,
  control,
  success = false,
  children,
}: {
  id: string
  label: string
  icon: ReactNode
  action?: ReactNode
  control?: ReactNode
  success?: boolean
  children: ReactNode
}) {
  return (
    <div className="auth-field">
      <div className="auth-field-top">
        <label htmlFor={id}>{label}</label>
        {action}
      </div>
      <div className={success ? 'auth-input-shell success' : 'auth-input-shell'}>
        <span className="auth-input-icon">{icon}</span>
        {children}
        {success ? <IconCheck className="auth-input-check" size={14} /> : control}
      </div>
    </div>
  )
}

function AuthFooter() {
  return (
    <footer className="auth-footer">
      <span>© 2026 ColdFlameUs LLC</span>
    </footer>
  )
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/** Reset links land on the web client as `…/reset?token=<token>`. Read the
 *  token from the URL so the screen opens straight into reset mode. */
function readResetToken(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  try {
    return new URLSearchParams(window.location.search).get('token') ?? ''
  } catch {
    return ''
  }
}

function authHeading(mode: AuthMode, t: Translator): string {
  switch (mode) {
    case 'register':
      return t('auth.heading.register')
    case 'forgot':
      return t('auth.forgot.heading')
    case 'reset':
      return t('auth.reset.heading')
    default:
      return t('auth.heading.login')
  }
}

function authSubheading(mode: AuthMode, t: Translator): string {
  switch (mode) {
    case 'register':
      return t('auth.subheading.register')
    case 'forgot':
      return t('auth.forgot.subheading')
    case 'reset':
      return t('auth.reset.subheading')
    default:
      return t('auth.subheading.login')
  }
}

function authSubmitLabel(mode: AuthMode, submitting: boolean, t: Translator): string {
  switch (mode) {
    case 'register':
      return submitting ? t('auth.submit.creating') : t('auth.submit.create')
    case 'forgot':
      return submitting ? t('auth.forgot.submitting') : t('auth.forgot.submit')
    case 'reset':
      return submitting ? t('auth.reset.submitting') : t('auth.reset.submit')
    default:
      return submitting ? t('auth.submit.signingIn') : t('auth.submit.login')
  }
}

function checkboxClass(checked: boolean): string {
  return checked ? 'auth-checkbox checked' : 'auth-checkbox'
}
