import type { TranslationKey, Translator } from '@/shared/i18n/i18n'
import type { LocalLarkSource } from '@/shared/local-host/client'

export type WorkConnectorID = 'lark' | 'calendar' | 'imap' | 'wecom'

export interface WorkConnectorDescriptor {
  id: WorkConnectorID
  glyph: string
  nameKey: TranslationKey
  descKey: TranslationKey
  connected: boolean
}

export interface WorkConnectorSourceView {
  id: string
  label: string
  sourceType: string
  selected: boolean
  source: LocalLarkSource
}

export const WORK_CONNECTORS: readonly WorkConnectorDescriptor[] = [
  { id: 'lark', glyph: '飞', nameKey: 'connections.lark.name', descKey: 'connections.lark.desc', connected: true },
  { id: 'calendar', glyph: '历', nameKey: 'connections.calendar.name', descKey: 'connections.calendar.desc', connected: true },
  { id: 'imap', glyph: '邮', nameKey: 'connections.imap.name', descKey: 'connections.imap.desc', connected: false },
  { id: 'wecom', glyph: '微', nameKey: 'connections.wecom.name', descKey: 'connections.wecom.desc', connected: false },
]

export function translateWorkConnectors(
  t: Translator,
  states: Record<WorkConnectorID, boolean>,
) {
  return WORK_CONNECTORS.map((connection) => ({
    ...connection,
    name: t(connection.nameKey),
    desc: t(connection.descKey),
    connected: states[connection.id],
  }))
}

export function toLarkSourceView(t: Translator, source: LocalLarkSource): WorkConnectorSourceView {
  return {
    id: source.id,
    label: source.display_label || t('connections.lark.unnamedSource'),
    sourceType: source.source_type,
    selected: source.sync_enabled,
    source,
  }
}

export function filterWorkConnectorSources(
  sources: WorkConnectorSourceView[],
  query: string,
): WorkConnectorSourceView[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return sources
  return sources.filter((source) =>
    `${source.label} ${source.sourceType}`.toLowerCase().includes(normalizedQuery),
  )
}

export function countSelectedSources(sources: WorkConnectorSourceView[]): number {
  return sources.filter((source) => source.selected).length
}
