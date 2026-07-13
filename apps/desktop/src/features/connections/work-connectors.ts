import type { TranslationKey, Translator } from '@/shared/i18n/i18n'

export type WorkConnectorID = 'calendar' | 'imap' | 'wecom'

export interface WorkConnectorDescriptor {
  id: WorkConnectorID
  glyph: string
  nameKey: TranslationKey
  descKey: TranslationKey
  connected: boolean
}

export const WORK_CONNECTORS: readonly WorkConnectorDescriptor[] = [
  { id: 'calendar', glyph: '历', nameKey: 'connections.calendar.name', descKey: 'connections.calendar.desc', connected: true },
  { id: 'imap', glyph: '邮', nameKey: 'connections.imap.name', descKey: 'connections.imap.desc', connected: false },
  { id: 'wecom', glyph: '微', nameKey: 'connections.wecom.name', descKey: 'connections.wecom.desc', connected: false },
]

export function translateWorkConnectors(t: Translator, states: Record<WorkConnectorID, boolean>) {
  return WORK_CONNECTORS.map((connection) => ({
    ...connection,
    name: t(connection.nameKey),
    desc: t(connection.descKey),
    connected: states[connection.id],
  }))
}
