import { useMemo, useState, type ReactNode } from 'react'
import {
  IconArrowRight,
  IconBrandAppleFilled,
  IconBrandGithubFilled,
  IconCheck,
  IconCircle,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconGift,
  IconLock,
  IconMail,
  IconShieldCheck,
  IconSparkles,
  IconTools,
  IconUser,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { AuthClient } from '@/shared/api/authClient'
import type { AuthPayload } from '@/shared/api/client'
import { LocaleSwitcher, useI18n, type TranslationKey } from '@/shared/i18n/i18n'

type AuthMode = 'login' | 'register'

const passwordChecks = [
  { key: 'length', labelKey: 'auth.password.check.length' },
  { key: 'number', labelKey: 'auth.password.check.number' },
  { key: 'mixedCase', labelKey: 'auth.password.check.mixedCase' },
  { key: 'symbol', labelKey: 'auth.password.check.symbol' },
] as const

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
  const pageClassName = window.jiandanDesktop ? 'auth-page electron-auth-page' : 'auth-page'
  const isRegistering = mode === 'register'
  const strength = useMemo(() => passwordStrength(password), [password])
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

  function showUnavailable(feature: string) {
    setError(t('auth.error.unavailable', { feature }))
  }

  return (
    <main className={pageClassName}>
      <Card className="auth-panel">
        <div className="auth-titlebar">
          <div className="auth-titlebar-title">Jiandanly</div>
          <LocaleSwitcher className="auth-language-switch" />
        </div>

        <div className={isRegistering ? 'auth-layout register' : 'auth-layout login'}>
          <BrandPanel mode={mode} />

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

              <SSOButtons compact={isRegistering} onSelect={showUnavailable} />

              <div className="auth-divider" aria-hidden="true">
                <span />
                <small>{t('auth.divider')}</small>
                <span />
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
                  action={
                    isRegistering ? undefined : (
                      <button type="button" onClick={() => showUnavailable(t('auth.password.forgot'))}>
                        {t('auth.password.forgot')}
                      </button>
                    )
                  }
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

                {isRegistering ? <PasswordStrength strength={strength} /> : null}

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

function BrandPanel({ mode }: { mode: AuthMode }) {
  const { t } = useI18n()
  const isRegistering = mode === 'register'

  return (
    <section className="auth-brand-panel" aria-label="Jiandanly">
      <div className="auth-wordmark">
        <span className="auth-wordmark-mark">
          <IconSparkles size={14} />
        </span>
        <span>Jiandanly</span>
      </div>

      <div className="auth-brand-story">
        <h2>{renderMultiline(isRegistering ? t('auth.brand.registerTitle') : t('auth.brand.loginTitle'))}</h2>
        <p>
          {isRegistering ? t('auth.brand.registerBody') : t('auth.brand.loginBody')}
        </p>
        {isRegistering ? <SignupSteps /> : <LoginFeatures />}
      </div>

      {isRegistering ? <FreePlanCard /> : <TestimonialCard />}
    </section>
  )
}

function LoginFeatures() {
  const { t } = useI18n()

  return (
    <div className="auth-feature-list">
      <FeatureItem icon={<IconTools size={12} />} tone="success" text={t('auth.features.tools')} />
      <FeatureItem icon={<IconShieldCheck size={12} />} tone="warning" text={t('auth.features.review')} />
      <FeatureItem icon={<IconFolder size={12} />} tone="info" text={t('auth.features.local')} />
    </div>
  )
}

function FeatureItem({ icon, tone, text }: { icon: ReactNode; tone: 'success' | 'warning' | 'info'; text: string }) {
  return (
    <div className="auth-feature-item">
      <span className={`auth-feature-icon ${tone}`}>{icon}</span>
      <span>{text}</span>
    </div>
  )
}

function SignupSteps() {
  const { t } = useI18n()

  return (
    <div className="auth-steps">
      <StepItem number="1" title={t('auth.steps.one.title')} text={t('auth.steps.one.text')} active />
      <StepItem number="2" title={t('auth.steps.two.title')} text={t('auth.steps.two.text')} />
      <StepItem number="3" title={t('auth.steps.three.title')} text={t('auth.steps.three.text')} />
    </div>
  )
}

function StepItem({ number, title, text, active = false }: { number: string; title: string; text: string; active?: boolean }) {
  return (
    <div className={active ? 'auth-step active' : 'auth-step'}>
      <span>{number}</span>
      <div>
        <strong>{title}</strong>
        <small>{text}</small>
      </div>
    </div>
  )
}

function TestimonialCard() {
  const { t } = useI18n()

  return (
    <div className="auth-note-card">
      <p>{t('auth.note.quote')}</p>
      <div className="auth-note-person">
        <span className="avatar">LZ</span>
        <div>
          <strong>Leon Zhang</strong>
          <small>{t('auth.note.person')}</small>
        </div>
      </div>
    </div>
  )
}

function FreePlanCard() {
  const { t } = useI18n()

  return (
    <div className="auth-note-card">
      <div className="auth-plan-title">
        <IconGift size={16} />
        <strong>{t('auth.plan.title')}</strong>
      </div>
      <p>{renderMultiline(t('auth.plan.body'))}</p>
    </div>
  )
}

function SSOButtons({ compact, onSelect }: { compact: boolean; onSelect: (feature: string) => void }) {
  const { t } = useI18n()
  const googleLabel = compact ? t('auth.sso.google') : t('auth.sso.googleFull')
  const appleLabel = compact ? t('auth.sso.apple') : t('auth.sso.appleFull')
  const githubLabel = compact ? t('auth.sso.github') : t('auth.sso.githubFull')

  return (
    <div className={compact ? 'auth-sso compact' : 'auth-sso'}>
      <button type="button" aria-label={googleLabel} onClick={() => onSelect(t('auth.sso.googleFeature'))}>
        <GoogleLogo size={compact ? 14 : 15} />
        {googleLabel}
      </button>
      <button type="button" aria-label={appleLabel} onClick={() => onSelect(t('auth.sso.appleFeature'))}>
        <IconBrandAppleFilled size={compact ? 14 : 16} />
        {appleLabel}
      </button>
      <button type="button" aria-label={githubLabel} onClick={() => onSelect(t('auth.sso.githubFeature'))}>
        <IconBrandGithubFilled size={compact ? 14 : 16} />
        {githubLabel}
      </button>
    </div>
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

function PasswordStrength({ strength }: { strength: ReturnType<typeof passwordStrength> }) {
  const { t } = useI18n()
  const level = strength.level ? t(strength.level) : t('auth.password.empty')

  return (
    <div className="auth-password-meter">
      <div className="auth-strength-bars" aria-label={t('auth.password.strength', { level })}>
        {[0, 1, 2, 3].map((index) => (
          <span className={index < strength.score ? strength.tone : ''} key={index} />
        ))}
      </div>
      <div className="auth-password-checks">
        {passwordChecks.map((item) => {
          const passed = strength.checks[item.key]
          return (
            <span className={passed ? 'passed' : ''} key={item.key}>
              {passed ? <IconCheck size={11} /> : <IconCircle size={11} />}
              {t(item.labelKey)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function AuthFooter() {
  const { t } = useI18n()

  return (
    <footer className="auth-footer">
      <span>© 2026 Jiandanly</span>
      <nav aria-label={t('auth.footer.legal')}>
        <a href="#privacy">{t('auth.footer.privacy')}</a>
        <a href="#terms">{t('auth.footer.terms')}</a>
        <a href="#support">{t('auth.footer.support')}</a>
      </nav>
    </footer>
  )
}

function GoogleLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962l3.007 2.332C4.672 5.167 6.656 3.58 9 3.58z" />
    </svg>
  )
}

function passwordStrength(password: string) {
  const checks = {
    length: password.length >= 12,
    number: /\d/.test(password),
    mixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    symbol: /[!@#$%^&*(),.?":{}|<>]/.test(password),
  }
  const score = Object.values(checks).filter(Boolean).length
  const level = ['', 'auth.password.level.weak', 'auth.password.level.fair', 'auth.password.level.strong', 'auth.password.level.excellent'][score] as TranslationKey | ''
  const tone = ['', 'danger', 'warning', 'success', 'success'][score]
  return { checks, score, level, tone }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function checkboxClass(checked: boolean): string {
  return checked ? 'auth-checkbox checked' : 'auth-checkbox'
}

function renderMultiline(value: string): ReactNode {
  const lines = value.split('\n')
  return lines.map((line, index) => (
    <span key={`${line}-${index}`}>
      {index > 0 ? <br /> : null}
      {line}
    </span>
  ))
}
