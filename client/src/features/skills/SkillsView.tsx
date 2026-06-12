import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconCheck,
  IconFolderOpen,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/shared/i18n/i18n'
import type { InstalledSkill, SkillCatalog, SkillRoot } from '@/shared/local-host/client'

export interface SkillsViewProps {
  listInstalled: () => Promise<SkillCatalog>
  /** Open a folder in the OS file manager. When the Electron bridge
   *  isn't wired (browser-only build) the Open-folder buttons hide. */
  onOpenFolder?: (path: string) => void
}

// Section ordering + display labels. Anything not in the map keeps its raw
// source string as the header — covers custom SHEJANE_LOCAL_SKILLS_PATH
// overrides without code changes.
const SECTION_ORDER: readonly string[] = ['claude', 'shejane']
const SECTION_LABEL: Record<string, { zh: string; en: string }> = {
  claude: { zh: '系统', en: 'System' },
  shejane: { zh: '个人', en: 'Personal' },
}

function sectionLabel(source: string, locale: string): string {
  const known = SECTION_LABEL[source]
  if (!known) return source
  return locale.startsWith('zh') ? known.zh : known.en
}

function matchesQuery(skill: InstalledSkill, needle: string): boolean {
  if (!needle) return true
  const hay = `${skill.name} ${skill.description ?? ''}`.toLowerCase()
  return hay.includes(needle)
}

const EMPTY_CATALOG: SkillCatalog = { skills: [], roots: [] }

function skillKind(source: string | undefined): 'builtin' | 'custom' {
  return source === 'shejane' ? 'custom' : 'builtin'
}

export function SkillsView({ listInstalled, onOpenFolder }: SkillsViewProps) {
  const { t, locale } = useI18n()
  const [catalog, setCatalog] = useState<SkillCatalog>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setCatalog(await listInstalled())
    } finally {
      setLoading(false)
    }
  }, [listInstalled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog.skills
    return catalog.skills.filter((s) => matchesQuery(s, needle))
  }, [catalog.skills, query])

  // Section list comes from `roots` so an empty Personal dir still
  // shows a header. Skills get bucketed under their `source`; anything
  // whose source isn't represented in roots (shouldn't happen — the
  // daemon owns both) falls back to an "Unknown" bucket.
  const sections = useMemo(() => {
    const buckets = new Map<string, InstalledSkill[]>()
    for (const skill of filteredSkills) {
      const key = skill.source ?? 'unknown'
      const list = buckets.get(key) ?? []
      list.push(skill)
      buckets.set(key, list)
    }
    const orderedRoots: SkillRoot[] = [...catalog.roots].sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.source)
      const bi = SECTION_ORDER.indexOf(b.source)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.source.localeCompare(b.source)
    })
    // Roots first (in canonical order), then any orphan source from
    // skills (defensive — shouldn't trigger in practice).
    const seen = new Set(orderedRoots.map((r) => r.source))
    const orphans = Array.from(buckets.keys())
      .filter((src) => !seen.has(src))
      .sort()
      .map<SkillRoot>((src) => ({ source: src, path: '' }))
    return [...orderedRoots, ...orphans].map((root) => ({
      root,
      skills: buckets.get(root.source) ?? [],
    }))
  }, [catalog.roots, filteredSkills])

  const totalCount = catalog.skills.length
  const filteredEmpty = totalCount > 0 && filteredSkills.length === 0
  const personalRootPath = useMemo(() => {
    return (
      catalog.roots.find((root) => root.source === 'shejane')?.path
      ?? catalog.skills.find((skill) => skill.source === 'shejane')?.root_path
      ?? ''
    )
  }, [catalog.roots, catalog.skills])
  const canCreateSkill = Boolean(onOpenFolder && personalRootPath)

  return (
    <section className="workspace skills-view">
      <header className="topbar topbar-page">
        <div className="chat-toolbar-title">
          <span>{t('skills.title')}</span>
        </div>
      </header>

      <div className="skills-scroll">
        <div className="skills-content">
          <div className="skills-toolbar">
            <div className="skills-search">
              <IconSearch className="skills-search-icon" size={15} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('skills.searchPlaceholder')}
                aria-label={t('skills.searchPlaceholder')}
              />
            </div>
            <div className="skills-toolbar-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="skills-refresh-button"
                onClick={() => void refresh()}
                disabled={loading}
                aria-label={t('skills.refresh')}
                title={t('skills.refresh')}
              >
                <IconRefresh size={14} aria-hidden="true" />
              </Button>
              {canCreateSkill ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="skills-new-button"
                  onClick={() => onOpenFolder?.(personalRootPath)}
                >
                  <IconPlus size={14} aria-hidden="true" />
                  {t('skills.newSkill')}
                </Button>
              ) : null}
            </div>
          </div>

          {filteredEmpty ? (
            <p className="skills-not-found">{t('skills.notFound')}</p>
          ) : null}

          {sections.map(({ root, skills }) => (
            <section className="skills-section" key={root.source}>
              <header className="skills-section-header">
                <h3 className="skills-section-title">{sectionLabel(root.source, locale)}</h3>
                {root.path && onOpenFolder ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="skills-section-open"
                    onClick={() => onOpenFolder(root.path)}
                    title={root.path}
                    aria-label={t('skills.openFolder')}
                  >
                    <IconFolderOpen size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </header>
              {skills.length === 0 ? (
                <p className="skills-section-empty">
                  {t('skills.section.emptyHint', { path: root.path || '—' })}
                </p>
              ) : (
                <div className="skills-grid">
                  {skills.map((skill) => (
                    <div className="skill-card" key={skill.path} data-source={root.source}>
                      <div className="skill-card-head">
                        <div className="skill-card-title">
                          <div className="skill-card-icon" aria-hidden="true">
                            <IconSparkles size={16} />
                          </div>
                          <div className="skill-card-name">{skill.name}</div>
                        </div>
                        <span className="skill-card-status" aria-label={t('skills.statusReady')}>
                          <span aria-hidden="true" />
                        </span>
                      </div>
                      <div className="skill-card-text">
                        {skill.description ? (
                          <div className="skill-card-desc">{skill.description}</div>
                        ) : null}
                      </div>
                      <div className="skill-card-footer">
                        <span className="skill-card-kind">
                          {t(skillKind(skill.source) === 'builtin' ? 'skills.kindBuiltin' : 'skills.kindCustom')}
                        </span>
                        <IconCheck className="skill-card-check" size={14} aria-hidden="true" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
