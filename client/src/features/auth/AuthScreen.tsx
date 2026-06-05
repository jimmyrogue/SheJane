import { useState, type ReactNode } from 'react'
import { IconArrowRight, IconCheck, IconEye, IconEyeOff, IconLock, IconMail, IconUser } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { AuthClient } from '@/shared/api/authClient'
import type { AuthPayload } from '@/shared/api/client'
import { appLogoURL } from '@/shared/assets/logo'
import { LocaleSwitcher, useI18n } from '@/shared/i18n/i18n'

type AuthMode = 'login' | 'register'

export function AuthScreen({ authClient, onAuthed }: { authClient: AuthClient; onAuthed: (payload: AuthPayload) => Promise<void> }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<AuthMode>('register')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [acceptedTerms, setAcceptedTerms] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const pageClassName = window.shejaneDesktop ? 'auth-page electron-auth-page' : 'auth-page'
  const isRegistering = mode === 'register'
  const emailLooksValid = isValidEmail(email)

  async function submit() {
    setError('')
    if (isRegistering && !acceptedTerms) {
      setError(t('auth.error.acceptTerms'))
      return
    }
    setIsSubmitting(true)
    try {
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
              <span>{isRegistering ? t('auth.mode.hasAccount') : t('auth.mode.noAccount')}</span>
              <button type="button" onClick={() => setMode(isRegistering ? 'login' : 'register')}>
                {isRegistering ? t('auth.mode.signIn') : t('auth.mode.create')}
              </button>
            </div>

            <div className="auth-form-wrap">
              <div className="auth-form-heading">
                <h1>{isRegistering ? t('auth.heading.register') : t('auth.heading.login')}</h1>
                <p>{isRegistering ? t('auth.subheading.register') : t('auth.subheading.login')}</p>
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

                <AuthField
                  id="auth-password"
                  label={t('auth.password.label')}
                  icon={<IconLock size={14} />}
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
                    aria-label={t('auth.password.label')}
                    autoComplete={isRegistering ? 'new-password' : 'current-password'}
                    value={password}
                    type={showPassword ? 'text' : 'password'}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={isRegistering ? t('auth.password.placeholder.register') : t('auth.password.placeholder.login')}
                  />
                </AuthField>

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

                {error ? (
                  <p className="auth-error" role="alert" aria-live="polite">
                    {error}
                  </p>
                ) : null}

                <Button className="auth-submit" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                  {isSubmitting
                    ? (isRegistering ? t('auth.submit.creating') : t('auth.submit.signingIn'))
                    : (isRegistering ? t('auth.submit.create') : t('auth.submit.login'))}
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

function checkboxClass(checked: boolean): string {
  return checked ? 'auth-checkbox checked' : 'auth-checkbox'
}
