import { useMemo, useState } from 'react'
import { IconCalendar, IconMail, IconMessageCircle, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useI18n, type TranslationKey, type Translator } from '@/shared/i18n/i18n'

type ConnectionID = 'lark' | 'calendar' | 'imap' | 'wecom'

interface WorkConnection {
  id: ConnectionID
  glyph: string
  nameKey: TranslationKey
  descKey: TranslationKey
  connected: boolean
}

const DEFAULT_CONNECTIONS: readonly WorkConnection[] = [
  { id: 'lark', glyph: '飞', nameKey: 'connections.lark.name', descKey: 'connections.lark.desc', connected: true },
  { id: 'calendar', glyph: '历', nameKey: 'connections.calendar.name', descKey: 'connections.calendar.desc', connected: true },
  { id: 'imap', glyph: '邮', nameKey: 'connections.imap.name', descKey: 'connections.imap.desc', connected: false },
  { id: 'wecom', glyph: '微', nameKey: 'connections.wecom.name', descKey: 'connections.wecom.desc', connected: false },
]

function connectionIcon(id: ConnectionID) {
  if (id === 'calendar') return <IconCalendar size={17} aria-hidden="true" />
  if (id === 'imap') return <IconMail size={17} aria-hidden="true" />
  return <IconMessageCircle size={17} aria-hidden="true" />
}

function translatedConnections(t: Translator, states: Record<ConnectionID, boolean>) {
  return DEFAULT_CONNECTIONS.map((connection) => ({
    ...connection,
    name: t(connection.nameKey),
    desc: t(connection.descKey),
    connected: states[connection.id],
  }))
}

export function ConnectionsView() {
  const { t } = useI18n()
  const [states, setStates] = useState<Record<ConnectionID, boolean>>(() =>
    DEFAULT_CONNECTIONS.reduce(
      (next, connection) => ({ ...next, [connection.id]: connection.connected }),
      {} as Record<ConnectionID, boolean>,
    ),
  )
  const connections = useMemo(() => translatedConnections(t, states), [states, t])

  function connect(id: ConnectionID) {
    setStates((current) => ({ ...current, [id]: true }))
  }

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
                    onClick={() => connect(connection.id)}
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
