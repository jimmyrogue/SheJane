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

type AuthMode = 'login' | 'register'

const passwordChecks = [
  { key: 'length', label: '12+ characters' },
  { key: 'number', label: 'Number' },
  { key: 'mixedCase', label: 'Mixed case' },
  { key: 'symbol', label: 'Symbol' },
] as const

export function AuthScreen({ authClient, onAuthed }: { authClient: AuthClient; onAuthed: (payload: AuthPayload) => Promise<void> }) {
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
      setError('Please accept the terms before creating an account.')
      return
    }
    setIsSubmitting(true)
    try {
      const payload = isRegistering
        ? await authClient.register({ email, password, name: name || email.split('@')[0] })
        : await authClient.login({ email, password })
      await onAuthed(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authentication failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  function showUnavailable(feature: string) {
    setError(`${feature} is not available yet.`)
  }

  return (
    <main className={pageClassName}>
      <Card className="auth-panel">
        <div className="auth-titlebar" aria-hidden="true">
          <div className="traffic-lights">
            <span className="tl-red" />
            <span className="tl-amber" />
            <span className="tl-green" />
          </div>
          <div className="auth-titlebar-title">Jiandanly</div>
        </div>

        <div className={isRegistering ? 'auth-layout register' : 'auth-layout login'}>
          <BrandPanel mode={mode} />

          <section className="auth-form-panel" aria-label={isRegistering ? 'Create your account' : 'Sign in'}>
            <div className="auth-mode-link">
              <span>{isRegistering ? 'Already have an account?' : 'New to Jiandanly?'}</span>
              <button type="button" onClick={() => setMode(isRegistering ? 'login' : 'register')}>
                {isRegistering ? 'Sign in' : 'Create account'}
                <span className="sr-only">{isRegistering ? '登录' : '注册'}</span>
              </button>
            </div>

            <div className="auth-form-wrap">
              <div className="auth-form-heading">
                <h1>{isRegistering ? 'Create your account' : 'Welcome back'}</h1>
                <p>{isRegistering ? 'Free forever. Upgrade when you outgrow it.' : 'Sign in to continue your work.'}</p>
              </div>

              <SSOButtons compact={isRegistering} onSelect={showUnavailable} />

              <div className="auth-divider" aria-hidden="true">
                <span />
                <small>or with email</small>
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
                  <AuthField id="auth-name" label="Name" icon={<IconUser size={14} />}>
                    <Input
                      id="auth-name"
                      aria-label="名称"
                      autoComplete="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Leon Zhang"
                    />
                  </AuthField>
                ) : null}

                <AuthField
                  id="auth-email"
                  label="Email"
                  icon={<IconMail size={14} />}
                  success={Boolean(email) && emailLooksValid}
                >
                  <Input
                    id="auth-email"
                    aria-label="邮箱"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </AuthField>

                <AuthField
                  id="auth-password"
                  label="Password"
                  action={
                    isRegistering ? undefined : (
                      <button type="button" onClick={() => showUnavailable('Password reset')}>
                        Forgot?
                      </button>
                    )
                  }
                  icon={<IconLock size={14} />}
                  control={
                    <button
                      className="auth-input-action"
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((current) => !current)}
                    >
                      {showPassword ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </button>
                  }
                >
                  <Input
                    id="auth-password"
                    aria-label="密码"
                    autoComplete={isRegistering ? 'new-password' : 'current-password'}
                    value={password}
                    type={showPassword ? 'text' : 'password'}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={isRegistering ? 'At least 8 characters' : 'Enter your password'}
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
                        I agree to the <a href="#terms">Terms of Service</a> and <a href="#privacy">Privacy Policy</a>.
                      </>
                    ) : (
                      'Keep me signed in on this device'
                    )}
                  </span>
                </div>

                {error ? (
                  <p className="auth-error" role="alert" aria-live="polite">
                    {error}
                  </p>
                ) : null}

                <Button className="auth-submit" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                  {isSubmitting ? (isRegistering ? 'Creating...' : 'Signing in...') : (isRegistering ? 'Create account' : 'Sign in')}
                  <IconArrowRight size={14} />
                  <span className="sr-only">{isRegistering ? '创建账号' : '登录'}</span>
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
        <h2>{isRegistering ? <>Get started in<br />under a minute.</> : <>Your AI agent,<br />now on your desktop.</>}</h2>
        <p>
          {isRegistering
            ? 'Free for personal use. No credit card required. Upgrade when the workflow outgrows the basics.'
            : 'Run multi-step tasks across your tools, code and files with full control over every action.'}
        </p>
        {isRegistering ? <SignupSteps /> : <LoginFeatures />}
      </div>

      {isRegistering ? <FreePlanCard /> : <TestimonialCard />}
    </section>
  )
}

function LoginFeatures() {
  return (
    <div className="auth-feature-list">
      <FeatureItem icon={<IconTools size={12} />} tone="success" text="Built-in tools and MCP connectors" />
      <FeatureItem icon={<IconShieldCheck size={12} />} tone="warning" text="Human review for sensitive actions" />
      <FeatureItem icon={<IconFolder size={12} />} tone="info" text="Local-first workspace, files stay on disk" />
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
  return (
    <div className="auth-steps">
      <StepItem number="1" title="Create your account" text="Email, Google, Apple, or GitHub." active />
      <StepItem number="2" title="Pick your tools" text="Connect GitHub, Notion, Slack, or start fresh." />
      <StepItem number="3" title="Run your first task" text="From spec to working code in minutes." />
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
  return (
    <div className="auth-note-card">
      <p>"Jiandanly replaced three separate dev tools for me. Seeing tool calls unfold in real time makes the agent feel trustworthy."</p>
      <div className="auth-note-person">
        <span className="avatar">LZ</span>
        <div>
          <strong>Leon Zhang</strong>
          <small>Product engineer · Shanghai</small>
        </div>
      </div>
    </div>
  )
}

function FreePlanCard() {
  return (
    <div className="auth-note-card">
      <div className="auth-plan-title">
        <IconGift size={16} />
        <strong>Free plan includes</strong>
      </div>
      <p>50 agent runs / month · Local chat history<br />Document reading · Community support</p>
    </div>
  )
}

function SSOButtons({ compact, onSelect }: { compact: boolean; onSelect: (feature: string) => void }) {
  const googleLabel = compact ? 'Google' : 'Continue with Google'
  const appleLabel = compact ? 'Apple' : 'Continue with Apple'
  const githubLabel = compact ? 'GitHub' : 'Continue with GitHub'

  return (
    <div className={compact ? 'auth-sso compact' : 'auth-sso'}>
      <button type="button" aria-label={googleLabel} onClick={() => onSelect('Google sign-in')}>
        <GoogleLogo size={compact ? 14 : 15} />
        {googleLabel}
      </button>
      <button type="button" aria-label={appleLabel} onClick={() => onSelect('Apple sign-in')}>
        <IconBrandAppleFilled size={compact ? 14 : 16} />
        {appleLabel}
      </button>
      <button type="button" aria-label={githubLabel} onClick={() => onSelect('GitHub sign-in')}>
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
  return (
    <div className="auth-password-meter">
      <div className="auth-strength-bars" aria-label={`Password strength ${strength.level || 'empty'}`}>
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
              {item.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function AuthFooter() {
  return (
    <footer className="auth-footer">
      <span>© 2026 Jiandanly</span>
      <nav aria-label="Legal">
        <a href="#privacy">Privacy</a>
        <a href="#terms">Terms</a>
        <a href="#support">Support</a>
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
  const level = ['', 'Weak', 'Fair', 'Strong', 'Excellent'][score]
  const tone = ['', 'danger', 'warning', 'success', 'success'][score]
  return { checks, score, level, tone }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function checkboxClass(checked: boolean): string {
  return checked ? 'auth-checkbox checked' : 'auth-checkbox'
}
