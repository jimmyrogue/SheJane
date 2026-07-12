import { useEffect, useState, type ReactNode } from 'react'
import { IconArrowRight, IconCheck, IconEye, IconEyeOff, IconLock, IconMail, IconUser } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AuthClient } from '@/shared/api/authClient'
import type { AuthPayload } from '@/shared/api/client'
import { appLogoLockupURL } from '@/shared/assets/logo'
import { LocaleSwitcher, useI18n, type Translator } from '@/shared/i18n/i18n'

type AuthMode = 'login' | 'register' | 'forgot' | 'reset'
type AuthFieldName = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<AuthFieldName, string>>

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const isDesktop = Boolean(window.shejaneDesktop)
  const pageClassName = isDesktop ? 'auth-page electron-auth-page' : 'auth-page'
  const isRegistering = mode === 'register'
  const isForgot = mode === 'forgot'
  const isReset = mode === 'reset'
  const isPasswordFlow = isForgot || isReset

  useEffect(() => {
    const bridge = window.shejaneDesktop
    if (bridge?.platform !== 'darwin' || !bridge.setWindowButtonPosition) {
      return
    }
    void bridge.setWindowButtonPosition('auth')
    return () => {
      void bridge.setWindowButtonPosition?.('app')
    }
  }, [])

  function switchMode(next: AuthMode) {
    setError('')
    setInfo('')
    setFieldErrors({})
    setPassword('')
    setMode(next)
  }

  function clearFieldError(field: AuthFieldName) {
    setFieldErrors((current) => {
      if (!current[field]) {
        return current
      }
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  async function submit() {
    const normalizedEmail = email.trim()
    const normalizedName = name.trim()
    const nextFieldErrors = validateAuthFields(mode, {
      email: normalizedEmail,
      name: normalizedName,
      password,
    }, t)

    setError('')
    setInfo('')
    setFieldErrors(nextFieldErrors)
    if (hasFieldErrors(nextFieldErrors)) {
      focusFirstInvalidField(mode, nextFieldErrors)
      return
    }

    if (isRegistering && !acceptedTerms) {
      setError(t('auth.error.acceptTerms'))
      return
    }
    setIsSubmitting(true)
    try {
      if (isForgot) {
        if (!onRequestPasswordReset) {
          setError(t('auth.error.unavailable', { feature: t('auth.forgot.heading') }))
          return
        }
        await onRequestPasswordReset(normalizedEmail)
        setInfo(t('auth.forgot.sent'))
        return
      }
      if (isReset) {
        if (!resetToken) {
          setError(t('auth.reset.invalidToken'))
          return
        }
        if (!onConfirmPasswordReset) {
          setError(t('auth.error.unavailable', { feature: t('auth.forgot.heading') }))
          return
        }
        await onConfirmPasswordReset(resetToken, password)
        setInfo(t('auth.reset.success'))
        setMode('login')
        return
      }
      const payload = isRegistering
        ? await authClient.register({ email: normalizedEmail, password, name: normalizedName || normalizedEmail.split('@')[0] })
        : await authClient.login({ email: normalizedEmail, password })
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
      <div className="auth-panel">
        <div className="auth-titlebar">
          <div className="auth-titlebar-left" aria-hidden="true">
            {!isDesktop ? (
              <div className="auth-window-lights">
                <i />
                <i />
                <i />
              </div>
            ) : null}
          </div>
          <LocaleSwitcher className="auth-language-switch" />
        </div>

        <div className={`auth-layout ${mode}`}>
          <section className="auth-brand-panel" aria-label={t('app.productName')}>
            <span className="auth-brand-halo" aria-hidden="true" />
            <span className="auth-brand-halo two" aria-hidden="true" />
            <div className="auth-wordmark">
              <img
                className="auth-wordmark-lockup"
                src={appLogoLockupURL}
                alt={t('app.productName')}
              />
              <p className="auth-brand-tagline">{t('auth.brand.tagline')}</p>
            </div>
            <div className="auth-brand-foot">{t('auth.brand.foot')}</div>
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
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                    return
                  }
                  if (!(event.target instanceof HTMLInputElement)) {
                    return
                  }
                  event.preventDefault()
                  void submit()
                }}
                onSubmit={(event) => {
                  event.preventDefault()
                  void submit()
                }}
              >
                {isRegistering ? (
                  <AuthField id="auth-name" label={t('auth.name.label')} icon={<IconUser size={14} />} error={fieldErrors.name}>
                    <Input
                      id="auth-name"
                      aria-label={t('auth.name.label')}
                      aria-invalid={Boolean(fieldErrors.name)}
                      aria-describedby={fieldErrors.name ? 'auth-name-error' : undefined}
                      autoComplete="name"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                        clearFieldError('name')
                      }}
                      placeholder={t('auth.name.placeholder')}
                    />
                  </AuthField>
                ) : null}

                {!isReset ? (
                  <AuthField
                    id="auth-email"
                    label={t('auth.email.label')}
                    icon={<IconMail size={14} />}
                    error={fieldErrors.email}
                  >
                    <Input
                      id="auth-email"
                      aria-label={t('auth.email.label')}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={fieldErrors.email ? 'auth-email-error' : undefined}
                      autoComplete="email"
                      inputMode="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        clearFieldError('email')
                      }}
                      onKeyDown={(event) => {
                        if (mode !== 'login' || event.key !== 'Tab' || event.shiftKey) {
                          return
                        }
                        const passwordInput = document.getElementById('auth-password')
                        if (passwordInput instanceof HTMLInputElement) {
                          event.preventDefault()
                          passwordInput.focus()
                        }
                      }}
                      placeholder={t('auth.email.placeholder')}
                    />
                  </AuthField>
                ) : null}

                {!isForgot ? (
                  <AuthField
                    id="auth-password"
                    label={isReset ? t('auth.reset.newPassword') : t('auth.password.label')}
                    icon={<IconLock size={14} />}
                    error={fieldErrors.password}
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
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={fieldErrors.password ? 'auth-password-error' : undefined}
                      autoComplete={isRegistering || isReset ? 'new-password' : 'current-password'}
                      value={password}
                      type={showPassword ? 'text' : 'password'}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        clearFieldError('password')
                      }}
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
      </div>
    </main>
  )
}

function AuthField({
  id,
  label,
  icon,
  action,
  control,
  error,
  children,
}: {
  id: string
  label: string
  icon: ReactNode
  action?: ReactNode
  control?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <div className="auth-field">
      <label className="auth-field-label" htmlFor={id}>{label}</label>
      <div className={error ? 'auth-input-shell invalid' : 'auth-input-shell'}>
        <span className="auth-input-icon">{icon}</span>
        {children}
        {control}
      </div>
      {action ? <div className="auth-field-action">{action}</div> : null}
      {error ? (
        <p id={`${id}-error`} className="auth-field-error" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function AuthFooter() {
  return (
    <footer className="auth-footer">
      <span>© 2026 TAO LIANG</span>
    </footer>
  )
}

/** Reset links land on the web client as `…/reset?token=<token>`. Read the
 *  token from the URL so the screen opens straight into reset mode. */
function readResetToken(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  try {
    // Gate on the /reset path so an email-verification link (/verify?token=)
    // doesn't get mistaken for a password-reset token.
    if (!window.location.pathname.includes('/reset')) {
      return ''
    }
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

function validateAuthFields(
  mode: AuthMode,
  input: { email: string; name: string; password: string },
  t: Translator,
): FieldErrors {
  const errors: FieldErrors = {}

  if (mode === 'register') {
    if (!input.name) {
      errors.name = t('auth.validation.nameRequired')
    }
    addEmailValidation(errors, input.email, t)
    addNewPasswordValidation(errors, input.password, t)
    return errors
  }

  if (mode === 'forgot') {
    addEmailValidation(errors, input.email, t)
    return errors
  }

  if (mode === 'reset') {
    addNewPasswordValidation(errors, input.password, t)
    return errors
  }

  addEmailValidation(errors, input.email, t)
  if (!input.password) {
    errors.password = t('auth.validation.passwordRequired')
  }
  return errors
}

function addEmailValidation(errors: FieldErrors, email: string, t: Translator) {
  if (!email) {
    errors.email = t('auth.validation.emailRequired')
    return
  }
  if (!isValidEmail(email)) {
    errors.email = t('auth.validation.emailInvalid')
  }
}

function addNewPasswordValidation(errors: FieldErrors, password: string, t: Translator) {
  if (!password) {
    errors.password = t('auth.validation.passwordRequired')
    return
  }
  if (password.length < 8) {
    errors.password = t('auth.validation.passwordTooShort')
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean)
}

function focusFirstInvalidField(mode: AuthMode, errors: FieldErrors) {
  const order: AuthFieldName[] = mode === 'register'
    ? ['name', 'email', 'password']
    : mode === 'reset'
      ? ['password']
      : ['email', 'password']
  const field = order.find((name) => errors[name])
  if (!field) {
    return
  }
  const element = document.getElementById(`auth-${field}`)
  if (element instanceof HTMLInputElement) {
    element.focus()
  }
}

function checkboxClass(checked: boolean): string {
  return checked ? 'auth-checkbox checked' : 'auth-checkbox'
}
