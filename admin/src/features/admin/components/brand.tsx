import adminAppIconURL from '@/assets/app-icon.png'
import adminLogoURL from '@/assets/logo.png'

export function BrandBlock({ subtitle, compact = false }: { subtitle: string; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {compact ? (
        <img className="admin-brand-mark" src={adminLogoURL} alt="" aria-hidden="true" />
      ) : (
        <img className="admin-auth-logo" src={adminAppIconURL} alt="" aria-hidden="true" />
      )}
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <div className={compact ? 'admin-brand-title truncate' : 'truncate text-sm font-semibold'}>{compact ? '石间 · 管理后台' : 'SheJane Admin'}</div>
        <div className={compact ? 'admin-brand-subtitle truncate' : 'truncate text-xs text-muted-foreground'}>{subtitle}</div>
      </div>
    </div>
  )
}

export function AdminAccountBlock({ email, onLogout }: { email: string; onLogout: () => Promise<void> }) {
  return (
    <button type="button" className="admin-account-block" onClick={() => void onLogout()} aria-label="退出登录" title="退出登录">
      <span className="admin-account-avatar">简</span>
      <span className="admin-account-copy">
        <span className="admin-account-name">管理员</span>
        <span className="admin-account-email">{email}</span>
      </span>
    </button>
  )
}
