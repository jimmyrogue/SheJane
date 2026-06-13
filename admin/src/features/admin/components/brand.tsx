import { Avatar, AvatarFallback } from '@/components/ui/avatar'

export function BrandBlock({ subtitle, compact = false }: { subtitle: string; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {compact ? (
        <StoneMark className="admin-brand-mark" size={26} />
      ) : (
        <Avatar className="admin-auth-avatar size-10 rounded-lg">
          <AvatarFallback className="rounded-lg">简</AvatarFallback>
        </Avatar>
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

function StoneMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <ellipse cx="12" cy="16.4" rx="8.2" ry="4.5" fill="currentColor" />
      <ellipse cx="11.2" cy="8.6" rx="5.5" ry="3.5" fill="currentColor" />
      <rect x="2" y="11.2" width="20" height="1.9" fill="var(--sj-paper-sunken)" />
      <circle cx="17.4" cy="7.4" r="1.7" fill="var(--sj-seal)" />
    </svg>
  )
}
