import { useState } from 'react'
import { IconCalendar, IconMail, IconMessageCircle, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/shared/i18n/i18n'
import { WORK_CONNECTORS, translateWorkConnectors, type WorkConnectorID } from './work-connectors'

function connectionIcon(id: WorkConnectorID) {
  if (id === 'calendar') return <IconCalendar size={17} aria-hidden="true" />
  if (id === 'imap') return <IconMail size={17} aria-hidden="true" />
  return <IconMessageCircle size={17} aria-hidden="true" />
}

export function ConnectionsView() {
  const { t } = useI18n()
  const [states, setStates] = useState<Record<WorkConnectorID, boolean>>(() =>
    Object.fromEntries(WORK_CONNECTORS.map((connection) => [connection.id, connection.connected])) as Record<WorkConnectorID, boolean>,
  )
  const connections = translateWorkConnectors(t, states)

  return (
    <section className="workspace">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('connections.title')}</span>
        </div>
      </header>

      <div className="skills-scroll">
        <div className="connections-content">
          <p className="connections-lead">{t('connections.intro')}</p>
          <div className="connections-list">
            {connections.map((connection) => (
              <div className="connection-row" key={connection.id}>
                <div className="connection-icon" aria-hidden="true">
                  <span className="connection-glyph">{connection.glyph}</span>
                  <span className="connection-symbol">{connectionIcon(connection.id)}</span>
                </div>
                <div className="connection-copy">
                  <div className="connection-name">{connection.name}</div>
                  <div className="connection-desc">{connection.desc}</div>
                </div>
                {connection.connected ? (
                  <div className="connection-status">
                    <span className="connection-status-dot" aria-hidden="true" />
                    {t('connections.connected')}
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="connection-action"
                    aria-label={t('connections.connectAria', { name: connection.name })}
                    onClick={() => setStates((current) => ({ ...current, [connection.id]: true }))}
                  >
                    {t('connections.connect')}
                  </Button>
                )}
              </div>
            ))}
          </div>

          <button type="button" className="connections-add">
            <IconPlus size={13} aria-hidden="true" />
            {t('connections.add')}
          </button>
        </div>
      </div>
    </section>
  )
}
