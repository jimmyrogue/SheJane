import type { LocalRunDiagnostics, SerializedEvent } from '../types.js'

export type ResearchFindingSeverity = 'error' | 'warning'

export interface ResearchDiagnosticFinding {
  severity: ResearchFindingSeverity
  code: string
  message: string
  detail?: string
  seq?: number
}

export interface ResearchDiagnosticsSummary {
  runId: string
  status: string
  events: number
  llmRounds: number
  toolRequests: number
  webSearches: number
  browserOpens: number
  collectedSources: number
  finalCitations: number
}

export interface ResearchDiagnosticsAnalysis {
  passed: boolean
  summary: ResearchDiagnosticsSummary
  findings: ResearchDiagnosticFinding[]
  collectedSources: Array<{ title?: string; url: string; seq: number }>
  finalCitations: string[]
}

export interface ResearchDiagnosticsOptions {
  targetSources?: number
  maxLLMRounds?: number
  maxToolRequests?: number
  maxWebSearches?: number
}

const defaultMaxLLMRounds = 16
const defaultMaxToolRequests = 24
const defaultMaxWebSearches = 8

export function analyzeResearchDiagnostics(
  diagnostics: LocalRunDiagnostics,
  options: ResearchDiagnosticsOptions = {},
): ResearchDiagnosticsAnalysis {
  const events = [...diagnostics.events].sort((left, right) => left.seq - right.seq)
  const targetSources = options.targetSources ?? requiredSourceCount(diagnostics.run.goal)
  const collectedByURL = new Map<string, { title?: string; url: string; seq: number }>()
  const findings: ResearchDiagnosticFinding[] = []
  let collectedCount = 0

  for (const event of events) {
    if (event.event_type === 'source.collected') {
      const url = typeof event.payload.url === 'string' ? canonicalURL(event.payload.url) : undefined
      if (url && !collectedByURL.has(url)) {
        collectedByURL.set(url, {
          url,
          title: typeof event.payload.title === 'string' ? event.payload.title : undefined,
          seq: event.seq,
        })
        collectedCount = collectedByURL.size
        if (isLikelyPortalURL(url)) {
          findings.push({
            severity: 'warning',
            code: 'weak_source_page',
            message: 'A collected source looks like a home, portal, or listing page rather than an article/detail page.',
            detail: url,
            seq: event.seq,
          })
        }
      }
      continue
    }

    if (
      event.event_type === 'tool.completed'
      && event.payload.tool === 'web.search'
      && collectedCount >= targetSources
    ) {
      findings.push({
        severity: 'error',
        code: 'metered_search_after_enough_sources',
        message: 'A metered web.search completed after the run had already collected enough usable sources.',
        detail: `collected_sources=${collectedCount}; target_sources=${targetSources}`,
        seq: event.seq,
      })
    }
  }

  const finalEvent = [...events].reverse().find((event) => event.event_type === 'run.completed')
  const final = typeof finalEvent?.payload.final === 'string' ? finalEvent.payload.final : ''
  const finalCitations = citedURLs(final)
  const collectedURLs = new Set(collectedByURL.keys())
  const uncollectedCitations = finalCitations.filter((url) => !collectedURLs.has(url))
  if (uncollectedCitations.length > 0) {
    findings.push({
      severity: 'error',
      code: 'uncollected_final_citation',
      message: 'The final answer cited URLs that were not collected as usable source pages in this run.',
      detail: uncollectedCitations.join(', '),
      seq: finalEvent?.seq,
    })
  }

  if (diagnostics.run.status !== 'completed') {
    findings.push({
      severity: 'error',
      code: 'run_not_completed',
      message: 'The run did not complete successfully.',
      detail: diagnostics.run.status,
    })
  }

  if (!finalEvent) {
    findings.push({
      severity: 'error',
      code: 'missing_final_answer',
      message: 'The event log does not contain run.completed.',
    })
  }

  const terminalSeq = firstTerminalSeq(events)
  if (terminalSeq !== undefined) {
    const lateEvents = events.filter((event) => event.seq > terminalSeq)
    if (lateEvents.length > 0) {
      findings.push({
        severity: 'error',
        code: 'events_after_terminal',
        message: 'Events were appended after the first terminal run event.',
        detail: lateEvents.map((event) => `${event.seq}:${event.event_type}`).join(', '),
        seq: lateEvents[0]?.seq,
      })
    }
  }

  if (collectedByURL.size < targetSources) {
    findings.push({
      severity: 'error',
      code: 'insufficient_collected_sources',
      message: 'The run collected fewer usable sources than requested.',
      detail: `collected_sources=${collectedByURL.size}; target_sources=${targetSources}`,
    })
  }

  if (finalCitations.length < targetSources) {
    findings.push({
      severity: 'error',
      code: 'missing_final_source_links',
      message: 'The final answer listed fewer source links than requested.',
      detail: `final_citations=${finalCitations.length}; target_sources=${targetSources}`,
      seq: finalEvent?.seq,
    })
  }

  const blockedEnoughSources = events.filter((event) =>
    event.event_type === 'tool.failed' && event.payload.error_code === 'research_enough_sources',
  )
  if (blockedEnoughSources.length >= 3) {
    findings.push({
      severity: 'warning',
      code: 'repeated_research_enough_sources_blocks',
      message: 'The model repeatedly tried to keep browsing after the harness said enough sources were collected.',
      detail: `blocked_attempts=${blockedEnoughSources.length}`,
      seq: blockedEnoughSources[0]?.seq,
    })
  }

  const summary = summarize(diagnostics, events, collectedByURL.size, finalCitations.length)
  if (summary.llmRounds > (options.maxLLMRounds ?? defaultMaxLLMRounds)) {
    findings.push({
      severity: 'warning',
      code: 'too_many_llm_rounds',
      message: 'The run used more LLM rounds than expected for this smoke task.',
      detail: `llm_rounds=${summary.llmRounds}; max=${options.maxLLMRounds ?? defaultMaxLLMRounds}`,
    })
  }
  if (summary.toolRequests > (options.maxToolRequests ?? defaultMaxToolRequests)) {
    findings.push({
      severity: 'warning',
      code: 'too_many_tool_requests',
      message: 'The run requested more tools than expected for this smoke task.',
      detail: `tool_requests=${summary.toolRequests}; max=${options.maxToolRequests ?? defaultMaxToolRequests}`,
    })
  }
  if (summary.webSearches > (options.maxWebSearches ?? defaultMaxWebSearches)) {
    findings.push({
      severity: 'warning',
      code: 'too_many_web_searches',
      message: 'The run used more web.search calls than expected for this smoke task.',
      detail: `web_searches=${summary.webSearches}; max=${options.maxWebSearches ?? defaultMaxWebSearches}`,
    })
  }

  return {
    passed: findings.every((finding) => finding.severity !== 'error'),
    summary,
    findings,
    collectedSources: [...collectedByURL.values()],
    finalCitations,
  }
}

export function formatResearchAnalysisMarkdown(analysis: ResearchDiagnosticsAnalysis): string {
  const lines = [
    `# Agent Research Smoke Analysis`,
    '',
    `- Result: ${analysis.passed ? 'PASS' : 'FAIL'}`,
    `- Run ID: ${analysis.summary.runId}`,
    `- Status: ${analysis.summary.status}`,
    `- Events: ${analysis.summary.events}`,
    `- LLM rounds: ${analysis.summary.llmRounds}`,
    `- Tool requests: ${analysis.summary.toolRequests}`,
    `- web.search calls: ${analysis.summary.webSearches}`,
    `- browser.open calls: ${analysis.summary.browserOpens}`,
    `- Collected sources: ${analysis.summary.collectedSources}`,
    `- Final citations: ${analysis.summary.finalCitations}`,
    '',
    `## Findings`,
    '',
  ]
  if (analysis.findings.length === 0) {
    lines.push('- None')
  } else {
    for (const finding of analysis.findings) {
      const prefix = finding.severity === 'error' ? 'ERROR' : 'WARN'
      lines.push(`- ${prefix} ${finding.code}${finding.seq ? ` @ seq ${finding.seq}` : ''}: ${finding.message}`)
      if (finding.detail) {
        lines.push(`  - ${finding.detail}`)
      }
    }
  }
  lines.push('', '## Collected Sources', '')
  if (analysis.collectedSources.length === 0) {
    lines.push('- None')
  } else {
    for (const source of analysis.collectedSources) {
      lines.push(`- ${source.title ? `${source.title} - ` : ''}${source.url}`)
    }
  }
  lines.push('', '## Final Citations', '')
  if (analysis.finalCitations.length === 0) {
    lines.push('- None')
  } else {
    for (const url of analysis.finalCitations) {
      lines.push(`- ${url}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function summarize(
  diagnostics: LocalRunDiagnostics,
  events: SerializedEvent[],
  collectedSources: number,
  finalCitations: number,
): ResearchDiagnosticsSummary {
  return {
    runId: diagnostics.run.id,
    status: diagnostics.run.status,
    events: events.length,
    llmRounds: events.filter((event) => event.event_type === 'llm.started').length,
    toolRequests: events.filter((event) => event.event_type === 'tool.requested').length,
    webSearches: events.filter((event) =>
      event.event_type === 'tool.completed' && event.payload.tool === 'web.search',
    ).length,
    browserOpens: events.filter((event) =>
      event.event_type === 'tool.completed' && event.payload.tool === 'browser.open',
    ).length,
    collectedSources,
    finalCitations,
  }
}

function firstTerminalSeq(events: SerializedEvent[]): number | undefined {
  return events.find((event) =>
    event.event_type === 'run.completed'
    || event.event_type === 'run.failed'
    || event.event_type === 'run.canceled',
  )?.seq
}

function requiredSourceCount(goal: string): number {
  const arabic = goal.match(/(\d+)\s*(?:个|篇|条)?\s*(?:可信|可靠|独立|公开|可引用|credible|reliable)?\s*(?:来源|信源|source|sources)/i)
  if (arabic) {
    const value = Number(arabic[1])
    if (Number.isFinite(value) && value > 0) {
      return Math.min(Math.floor(value), 10)
    }
  }
  if (/(两个|两篇|两条|two)\s*(?:来源|信源|source|sources)/i.test(goal)) {
    return 2
  }
  return 1
}

function citedURLs(content: string): string[] {
  const urls = new Set<string>()
  for (const match of content.matchAll(/https?:\/\/[^\s)\]）}>"'，。；;、]+/gi)) {
    const canonical = canonicalURL(match[0].replace(/[,.!?，。！？]+$/g, ''))
    if (canonical) {
      urls.add(canonical)
    }
  }
  return [...urls]
}

function canonicalURL(rawURL: string): string | undefined {
  try {
    const url = new URL(rawURL)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    url.searchParams.sort()
    return url.href
  } catch {
    return undefined
  }
}

function isLikelyPortalURL(rawURL: string): boolean {
  try {
    const url = new URL(rawURL)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === '/') {
      return true
    }
    return /^\/(?:news|technology|tech|ai|kaijiang|search|topics?)$/i.test(path)
  } catch {
    return false
  }
}
