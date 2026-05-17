import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconChevronLeft, IconChevronRight, IconExternalLink, IconPlus, IconSearch } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/shared/i18n/i18n'
import type { InstalledSkill, RegistrySkill, SkillInstallOutcome } from '@/shared/local-host/client'

export interface SkillsViewProps {
  searchRegistry: (query: string) => Promise<{ skills: RegistrySkill[]; error?: string }>
  listInstalled: () => Promise<InstalledSkill[]>
  installSkill: (ref: { source: string; skillId: string }) => Promise<SkillInstallOutcome>
  onCreateSkill: (description: string) => void
}

const pageSize = 9

function githubURL(source: string): string {
  if (/^https?:\/\//.test(source)) {
    return source
  }
  const parts = source.split('/').filter(Boolean)
  if (parts.length >= 2) {
    return `https://github.com/${parts[0]}/${parts[1]}`
  }
  return `https://github.com/${source}`
}

export function SkillsView({ searchRegistry, listInstalled, installSkill, onCreateSkill }: SkillsViewProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistrySkill[]>([])
  const [page, setPage] = useState(1)
  const [installedPage, setInstalledPage] = useState(1)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [registryError, setRegistryError] = useState<string | undefined>()
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const refreshInstalled = useCallback(() => {
    void listInstalled()
      .then(setInstalled)
      .catch(() => undefined)
  }, [listInstalled])

  useEffect(() => {
    refreshInstalled()
  }, [refreshInstalled])

  const installedNames = useMemo(() => new Set(installed.map((skill) => skill.name)), [installed])
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageResults = useMemo(
    () => results.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [results, currentPage],
  )
  const installedTotalPages = Math.max(1, Math.ceil(installed.length / pageSize))
  const currentInstalledPage = Math.min(installedPage, installedTotalPages)
  const pageInstalled = useMemo(
    () => installed.slice((currentInstalledPage - 1) * pageSize, currentInstalledPage * pageSize),
    [installed, currentInstalledPage],
  )

  const renderPagination = (current: number, total: number, go: (next: number) => void) =>
    total > 1 ? (
      <div className="skills-pagination">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={current <= 1}
          onClick={() => go(Math.max(1, current - 1))}
        >
          <IconChevronLeft size={14} aria-hidden="true" />
          {t('skills.pagination.prev')}
        </Button>
        <span className="skills-pagination-label">
          {t('skills.pagination.page', { page: current, total })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={current >= total}
          onClick={() => go(Math.min(total, current + 1))}
        >
          {t('skills.pagination.next')}
          <IconChevronRight size={14} aria-hidden="true" />
        </Button>
      </div>
    ) : null

  async function runSearch() {
    const trimmed = query.trim()
    if (!trimmed || searching) {
      return
    }
    setSearching(true)
    setRegistryError(undefined)
    try {
      const outcome = await searchRegistry(trimmed)
      setResults(outcome.skills)
      setPage(1)
      setRegistryError(outcome.error ? t('skills.registryError') : undefined)
    } catch {
      setResults([])
      setRegistryError(t('skills.registryError'))
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }

  async function runInstall(skill: RegistrySkill) {
    if (installing[skill.id]) {
      return
    }
    setInstalling((current) => ({ ...current, [skill.id]: true }))
    setInstallErrors((current) => {
      const next = { ...current }
      delete next[skill.id]
      return next
    })
    try {
      const outcome = await installSkill({ source: skill.source, skillId: skill.skillId })
      if (outcome.ok) {
        refreshInstalled()
      } else {
        setInstallErrors((current) => ({
          ...current,
          [skill.id]: t('skills.installFailed', { message: outcome.error || outcome.stderr || '' }),
        }))
      }
    } catch (error) {
      setInstallErrors((current) => ({
        ...current,
        [skill.id]: t('skills.installFailed', { message: error instanceof Error ? error.message : '' }),
      }))
    } finally {
      setInstalling((current) => {
        const next = { ...current }
        delete next[skill.id]
        return next
      })
    }
  }

  async function submitCreate() {
    const trimmed = description.trim()
    if (!trimmed || creating) {
      return
    }
    setCreating(true)
    try {
      await onCreateSkill(trimmed)
      setCreateOpen(false)
      setDescription('')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="workspace">
      <header className="topbar">
        <div className="chat-toolbar-title">
          <span>{t('skills.title')}</span>
        </div>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <IconPlus size={14} aria-hidden="true" />
          {t('skills.create.title')}
        </Button>
      </header>

      <div className="skills-scroll">
        <p className="skills-subtitle">{t('skills.subtitle')}</p>

        <form
          className="skills-search"
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch()
          }}
        >
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('skills.searchPlaceholder')}
            aria-label={t('skills.searchPlaceholder')}
          />
          <Button type="submit" disabled={searching || !query.trim()}>
            <IconSearch size={14} aria-hidden="true" />
            {searching ? t('skills.searching') : t('skills.search')}
          </Button>
        </form>

        {registryError ? <p className="skills-error">{registryError}</p> : null}

        {searched && !searching && results.length === 0 && !registryError ? (
          <p className="skills-empty">{t('skills.noResults')}</p>
        ) : null}

        {results.length > 0 ? (
          <>
            <p className="skills-results-summary">{t('skills.resultsSummary', { count: results.length })}</p>
            <div className="skills-grid">
              {pageResults.map((skill) => {
                const isInstalled = installedNames.has(skill.skillId) || installedNames.has(skill.name)
                return (
                  <Card key={skill.id} size="sm">
                    <CardHeader>
                      <CardTitle>{skill.name}</CardTitle>
                      <div className="skills-card-meta">
                        <a
                          href={githubURL(skill.source)}
                          target="_blank"
                          rel="noreferrer"
                          className="skills-source-link"
                        >
                          {skill.source}
                          <IconExternalLink size={12} aria-hidden="true" />
                        </a>
                        <span className="skills-installs">{t('skills.installs', { count: skill.installs })}</span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Button
                        type="button"
                        size="sm"
                        variant={isInstalled ? 'ghost' : 'default'}
                        disabled={isInstalled || Boolean(installing[skill.id])}
                        onClick={() => void runInstall(skill)}
                      >
                        {isInstalled
                          ? t('skills.installed')
                          : installing[skill.id]
                            ? t('skills.installing')
                            : t('skills.install')}
                      </Button>
                      {installErrors[skill.id] ? (
                        <p className="skills-error">{installErrors[skill.id]}</p>
                      ) : null}
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {renderPagination(currentPage, totalPages, setPage)}
          </>
        ) : null}

        <section className="skills-section">
          <h2 className="skills-section-title">{t('skills.installedSection')}</h2>
          {installed.length === 0 ? (
            <p className="skills-empty">{t('skills.installedEmpty')}</p>
          ) : (
            <>
              <p className="skills-results-summary">
                {t('skills.resultsSummary', { count: installed.length })}
              </p>
              <ul className="skills-installed-list">
                {pageInstalled.map((skill) => (
                  <li key={skill.path} className="skills-installed-item">
                    <span className="skills-installed-name">{skill.name}</span>
                    <span className="skills-installed-desc">{skill.description}</span>
                  </li>
                ))}
              </ul>
              {renderPagination(currentInstalledPage, installedTotalPages, setInstalledPage)}
            </>
          )}
        </section>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t('skills.create.title')}</DialogTitle>
            <DialogDescription>{t('skills.create.hint')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('skills.create.placeholder')}
            aria-label={t('skills.create.title')}
            rows={4}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              {t('skills.create.cancel')}
            </Button>
            <Button type="button" disabled={creating || !description.trim()} onClick={() => void submitCreate()}>
              {creating ? t('skills.create.creating') : t('skills.create.button')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
