import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconDownload,
  IconExternalLink,
  IconPlus,
  IconSearch,
  IconSparkles,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [installFilter, setInstallFilter] = useState('')
  const [installedPage, setInstalledPage] = useState(1)

  const [installOpen, setInstallOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistrySkill[]>([])
  const [page, setPage] = useState(1)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [registryError, setRegistryError] = useState<string | undefined>()
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

  useEffect(() => {
    setInstalledPage(1)
  }, [installFilter])

  const installedNames = useMemo(() => new Set(installed.map((skill) => skill.name)), [installed])

  const filteredInstalled = useMemo(() => {
    const needle = installFilter.trim().toLowerCase()
    if (!needle) {
      return installed
    }
    return installed.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
    )
  }, [installed, installFilter])

  const installedTotalPages = Math.max(1, Math.ceil(filteredInstalled.length / pageSize))
  const currentInstalledPage = Math.min(installedPage, installedTotalPages)
  const pageInstalled = useMemo(
    () => filteredInstalled.slice((currentInstalledPage - 1) * pageSize, currentInstalledPage * pageSize),
    [filteredInstalled, currentInstalledPage],
  )

  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageResults = useMemo(
    () => results.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [results, currentPage],
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

  const hasInstalled = installed.length > 0
  const filterActive = installFilter.trim().length > 0

  return (
    <section className="workspace">
      <header className="topbar">
        <div className="chat-toolbar-title">
          <span>{t('skills.title')}</span>
        </div>
        <div className="skills-topbar-actions">
          <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <IconPlus size={14} aria-hidden="true" />
            {t('skills.create.title')}
          </Button>
          <Button type="button" size="sm" onClick={() => setInstallOpen(true)}>
            <IconDownload size={14} aria-hidden="true" />
            {t('skills.install.open')}
          </Button>
        </div>
      </header>

      <div className="skills-scroll">
        <p className="skills-subtitle">{t('skills.subtitle')}</p>

        {!hasInstalled ? (
          <div className="skills-empty-cta">
            <span className="skills-empty-glyph" aria-hidden="true">
              <IconSparkles size={26} />
            </span>
            <p>{t('skills.emptyCta')}</p>
            <div className="skills-empty-actions">
              <Button type="button" onClick={() => setInstallOpen(true)}>
                <IconDownload size={14} aria-hidden="true" />
                {t('skills.install.open')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
                <IconPlus size={14} aria-hidden="true" />
                {t('skills.create.title')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="skills-filter-row">
              <div className="skills-filter">
                <IconSearch className="skills-filter-icon" size={15} aria-hidden="true" />
                <Input
                  type="search"
                  value={installFilter}
                  onChange={(event) => setInstallFilter(event.target.value)}
                  placeholder={t('skills.filterPlaceholder')}
                  aria-label={t('skills.filterPlaceholder')}
                />
              </div>
              <span className="skills-count">
                {filterActive
                  ? t('skills.countFiltered', { total: installed.length, shown: filteredInstalled.length })
                  : t('skills.countAll', { count: installed.length })}
              </span>
            </div>

            {filteredInstalled.length === 0 ? (
              <div className="skills-empty">
                <p>{t('skills.filterEmpty')}</p>
                <Button type="button" variant="ghost" size="sm" onClick={() => setInstallFilter('')}>
                  {t('skills.clearFilter')}
                </Button>
              </div>
            ) : (
              <>
                <div className="skills-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="skills-table-name-col">{t('skills.col.name')}</TableHead>
                        <TableHead>{t('skills.col.desc')}</TableHead>
                        <TableHead className="skills-table-status-col">{t('skills.col.status')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageInstalled.map((skill) => (
                        <TableRow key={skill.path}>
                          <TableCell>
                            <span className="skills-table-name">
                              <span className="skills-installed-glyph" aria-hidden="true">
                                <IconSparkles size={14} />
                              </span>
                              {skill.name}
                            </span>
                          </TableCell>
                          <TableCell className="skills-table-desc">{skill.description}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="skills-status-badge">
                              <IconCircleCheck size={12} aria-hidden="true" />
                              {t('skills.installed')}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {renderPagination(currentInstalledPage, installedTotalPages, setInstalledPage)}
              </>
            )}
          </>
        )}
      </div>

      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="skills-install-dialog sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{t('skills.install.title')}</DialogTitle>
            <DialogDescription>{t('skills.install.desc')}</DialogDescription>
          </DialogHeader>

          <div className="skills-dialog-scroll">
            <form
              className="skills-searchbar"
              onSubmit={(event) => {
                event.preventDefault()
                void runSearch()
              }}
            >
              <IconSearch className="skills-searchbar-icon" size={16} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('skills.searchPlaceholder')}
                aria-label={t('skills.searchPlaceholder')}
              />
              <Button type="submit" size="sm" disabled={searching || !query.trim()}>
                {searching ? t('skills.searching') : t('skills.search')}
              </Button>
            </form>

            {registryError ? <p className="skills-error">{registryError}</p> : null}

            {searched && !searching && results.length === 0 && !registryError ? (
              <p className="skills-empty">{t('skills.noResults')}</p>
            ) : null}

            {!searched && !registryError && results.length === 0 ? (
              <p className="skills-empty">{t('skills.install.hint')}</p>
            ) : null}

            {results.length > 0 ? (
              <>
                <p className="skills-results-summary">
                  {t('skills.resultsSummary', { count: results.length })}
                </p>
                <div className="skills-grid">
                  {pageResults.map((skill) => {
                    const isInstalled =
                      installedNames.has(skill.skillId) || installedNames.has(skill.name)
                    return (
                      <Card key={skill.id} size="sm" className="skills-card">
                        <CardHeader>
                          <div className="skills-card-head">
                            <span className="skills-card-glyph" aria-hidden="true">
                              <IconSparkles size={15} />
                            </span>
                            <CardTitle className="skills-card-title">{skill.name}</CardTitle>
                          </div>
                          <div className="skills-card-meta">
                            <a
                              href={githubURL(skill.source)}
                              target="_blank"
                              rel="noreferrer"
                              className="skills-source-link"
                            >
                              {skill.source}
                              <IconExternalLink size={11} aria-hidden="true" />
                            </a>
                            <span className="skills-installs">
                              <IconDownload size={11} aria-hidden="true" />
                              {t('skills.installs', { count: skill.installs })}
                            </span>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <Button
                            type="button"
                            size="sm"
                            className="skills-install-btn"
                            variant={isInstalled ? 'outline' : 'default'}
                            disabled={isInstalled || Boolean(installing[skill.id])}
                            onClick={() => void runInstall(skill)}
                          >
                            {isInstalled ? (
                              <>
                                <IconCircleCheck size={14} aria-hidden="true" />
                                {t('skills.installed')}
                              </>
                            ) : installing[skill.id] ? (
                              t('skills.installing')
                            ) : (
                              <>
                                <IconDownload size={14} aria-hidden="true" />
                                {t('skills.install')}
                              </>
                            )}
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
          </div>

          <DialogFooter>
            <Button type="button" onClick={() => setInstallOpen(false)}>
              {t('skills.install.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('skills.create.title')}</DialogTitle>
            <DialogDescription>{t('skills.create.desc')}</DialogDescription>
          </DialogHeader>
          <ol className="skills-create-steps">
            <li>{t('skills.create.step1')}</li>
            <li>{t('skills.create.step2')}</li>
            <li>{t('skills.create.step3')}</li>
          </ol>
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
