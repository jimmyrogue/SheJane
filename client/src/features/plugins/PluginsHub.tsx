import type { KeyboardEvent, ReactNode } from 'react'
import { useI18n } from '@/shared/i18n/i18n'

export type PluginsHubTab = 'skills' | 'mcp' | 'plugins'

export function PluginsHub({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: PluginsHubTab
  onTabChange: (tab: PluginsHubTab) => void
  children: ReactNode
}) {
  const { t } = useI18n()
  const tabs: { id: PluginsHubTab; label: string }[] = [
    { id: 'plugins', label: t('plugins.title') },
    { id: 'skills', label: t('skills.title') },
    { id: 'mcp', label: t('mcp.title') },
  ]

  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return

    event.preventDefault()
    onTabChange(tabs[next].id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }

  return (
    <section className="workspace plugins-hub">
      <header className="topbar topbar-page plugins-hub-header">
        <div className="chat-toolbar-title">{t('plugins.title')}</div>
        <div className="plugins-hub-tabs" role="tablist" aria-label={t('plugins.title')}>
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTab
            return (
              <button
                key={tab.id}
                id={`plugins-hub-tab-${tab.id}`}
                className="plugins-hub-tab"
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="plugins-hub-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => selectFromKeyboard(event, index)}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </header>
      <div
        id="plugins-hub-panel"
        className="plugins-hub-panel"
        role="tabpanel"
        aria-labelledby={`plugins-hub-tab-${activeTab}`}
      >
        {children}
      </div>
    </section>
  )
}
