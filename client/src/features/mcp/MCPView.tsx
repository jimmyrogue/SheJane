import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconExternalLink,
  IconFileDescription,
  IconRefresh,
  IconSearch,
  IconServer,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/shared/i18n/i18n'
import type { McpServerCatalog, McpServerInfo } from '@/shared/local-host/client'

export interface MCPViewProps {
  listCatalog: () => Promise<McpServerCatalog>
  /** Names the user explicitly disabled. The switch is OFF for names
   *  in this set; flipping it removes (or adds) the name. We track
   *  *disabled* rather than *enabled* so newly discovered servers
   *  default to ON without the renderer having to touch state. */
  disabledServers: readonly string[]
  onDisabledChange: (next: string[]) => void
  /** Open the config file's parent directory in the OS file manager.
   *  Hidden when the Electron bridge isn't wired (browser-only). */
  onOpenFolder?: (path: string) => void
}

// Section ordering + display labels mirror the SkillsView convention.
// We keep our own source key on the daemon side (see tools/mcp.py
// `SOURCE_*` constants) so the renderer can group consistently.
const SECTION_ORDER: readonly string[] = [
  'claude-desktop',
  'cursor',
  'codex',
  'shejane',
  'shejane-legacy',
  'env',
]
const SECTION_LABEL: Record<string, { zh: string; en: string }> = {
  'claude-desktop': { zh: 'Claude Desktop', en: 'Claude Desktop' },
  cursor: { zh: 'Cursor', en: 'Cursor' },
  codex: { zh: 'Codex', en: 'Codex' },
  shejane: { zh: '个人', en: 'Personal' },
  'shejane-legacy': { zh: '历史配置', en: 'Legacy config' },
  env: { zh: '环境变量', en: 'Environment override' },
}

function sectionLabel(source: string, locale: string): string {
  const known = SECTION_LABEL[source]
  if (!known) return source
  return locale.startsWith('zh') ? known.zh : known.en
}

function matchesQuery(server: McpServerInfo, needle: string): boolean {
  if (!needle) return true
  const haystack = `${server.name} ${server.command ?? ''} ${server.url ?? ''}`.toLowerCase()
  return haystack.includes(needle)
}

const EMPTY_CATALOG: McpServerCatalog = { servers: [], sources_scanned: [] }

export function MCPView({
  listCatalog,
  disabledServers,
  onDisabledChange,
  onOpenFolder,
}: MCPViewProps) {
  const { t, locale } = useI18n()
  const [catalog, setCatalog] = useState<McpServerCatalog>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setCatalog(await listCatalog())
    } finally {
      setLoading(false)
    }
  }, [listCatalog])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const disabledSet = useMemo(() => new Set(disabledServers), [disabledServers])

  const filteredServers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog.servers
    return catalog.servers.filter((s) => matchesQuery(s, needle))
  }, [catalog.servers, query])

  // Group filtered servers by their `source` label. Unlike skills (which
  // also surfaces empty source directories so the user knows where to
  // drop a SKILL.md), MCP sources are config files — we only show a
  // section header when the source actually exists. The exception is
  // `shejane`, which we always show with a "drop a config here" hint
  // so the user knows their canonical override path.
  const sections = useMemo(() => {
    const buckets = new Map<string, McpServerInfo[]>()
    for (const server of filteredServers) {
      const list = buckets.get(server.source) ?? []
      list.push(server)
      buckets.set(server.source, list)
    }
    const allSources = new Set<string>(catalog.servers.map((s) => s.source))
    allSources.add('shejane') // always render the personal section header
    return Array.from(allSources)
      .sort((a, b) => {
        const ai = SECTION_ORDER.indexOf(a)
        const bi = SECTION_ORDER.indexOf(b)
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return a.localeCompare(b)
      })
      .map((source) => ({
        source,
        servers: buckets.get(source) ?? [],
        // Pick any representative server's source_path for the
        // "open folder" button. All servers from one source share
        // the same config file.
        anyPath:
          catalog.servers.find((s) => s.source === source)?.source_path ?? '',
      }))
  }, [catalog.servers, filteredServers])

  const toggle = useCallback(
    (name: string) => {
      const next = new Set(disabledServers)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      onDisabledChange(Array.from(next))
    },
    [disabledServers, onDisabledChange],
  )

  const totalCount = catalog.servers.length
  const filteredEmpty = totalCount > 0 && filteredServers.length === 0

  return (
    <section className="workspace">
      <header className="topbar">
        <div className="chat-toolbar-title">
          <span>{t('mcp.title')}</span>
        </div>
        <div className="skills-topbar-actions">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <IconRefresh size={14} aria-hidden="true" />
            {t('mcp.refresh')}
          </Button>
        </div>
      </header>

      <div className="skills-scroll">
        <div className="skills-content">
          {totalCount > 0 ? (
            <div className="skills-search">
              <IconSearch className="skills-search-icon" size={15} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('mcp.searchPlaceholder')}
                aria-label={t('mcp.searchPlaceholder')}
              />
            </div>
          ) : null}

          {filteredEmpty ? <p className="skills-not-found">{t('mcp.notFound')}</p> : null}

          {totalCount === 0 && !loading ? (
            <p className="mcp-overall-empty">{t('mcp.empty')}</p>
          ) : null}

          {sections.map(({ source, servers, anyPath }) => (
            <section className="skills-section" key={source}>
              <header className="skills-section-header">
                <h3 className="skills-section-title">{sectionLabel(source, locale)}</h3>
                {anyPath && onOpenFolder ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="skills-section-open"
                    onClick={() => onOpenFolder(anyPath)}
                    title={anyPath}
                    aria-label={t('mcp.openConfig')}
                  >
                    <IconFileDescription size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </header>
              {servers.length === 0 ? (
                <p className="skills-section-empty">
                  {source === 'shejane'
                    ? t('mcp.section.personalEmptyHint')
                    : t('mcp.section.emptyHint')}
                </p>
              ) : (
                <div className="mcp-list">
                  {servers.map((server) => {
                    const isOff = disabledSet.has(server.name)
                    return (
                      <div className="mcp-row" key={server.name} data-disabled={isOff || undefined}>
                        <div className="mcp-row-icon" aria-hidden="true">
                          <IconServer size={18} />
                        </div>
                        <div className="mcp-row-body">
                          <div className="mcp-row-title">
                            <span className="mcp-row-name">{server.name}</span>
                            <span className="mcp-row-transport">{server.transport}</span>
                          </div>
                          <div className="mcp-row-meta">
                            {server.command ? (
                              <span className="mcp-row-cmd" title={server.command}>
                                {server.command}
                                {server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}
                              </span>
                            ) : null}
                            {server.url ? (
                              <span className="mcp-row-url">
                                <IconExternalLink size={12} aria-hidden="true" />
                                {server.url}
                              </span>
                            ) : null}
                            {server.env_keys.length > 0 ? (
                              <span className="mcp-row-envs">
                                env: {server.env_keys.join(', ')}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!isOff}
                          aria-label={server.name}
                          className="agent-settings-switch"
                          onClick={() => toggle(server.name)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
