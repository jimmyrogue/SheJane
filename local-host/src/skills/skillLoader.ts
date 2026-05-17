import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A discovered skill: its identity (name) and a short one-line description.
 * This is the cheap "catalog" projection that is advertised to the model on
 * every turn (progressive disclosure). The full instructions live in `body`,
 * loaded on demand only when the model calls skill.use.
 */
export interface SkillSummary {
  name: string
  description: string
  /** Absolute path to the skill's SKILL.md file. */
  path: string
}

export interface SkillDetail extends SkillSummary {
  body: string
}

const descriptionFallbackMax = 200

interface ParsedFrontmatter {
  name?: string
  description?: string
  body: string
}

/**
 * Minimal SKILL.md parser. Recognizes the Claude-Code-style YAML-ish
 * frontmatter block delimited by lines containing only `---`, and pulls the
 * single-line `name:` / `description:` fields out of it. We deliberately do
 * NOT pull in a YAML dependency — only two scalar fields are needed and a
 * permissive line parser keeps malformed skills from crashing discovery.
 */
export function parseSkillFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { body: normalized }
  }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) {
    return { body: normalized }
  }
  const frontmatter = normalized.slice(4, end)
  // Skip past the closing `---` line.
  const afterFence = normalized.indexOf('\n', end + 1)
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1)
  const result: ParsedFrontmatter = { body }
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const sep = line.indexOf(':')
    if (sep === -1) {
      continue
    }
    const key = line.slice(0, sep).trim().toLowerCase()
    let value = line.slice(sep + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key === 'name' && value) {
      result.name = value
    } else if (key === 'description' && value) {
      result.description = value
    }
  }
  return result
}

function cap(value: string): string {
  return value.length > descriptionFallbackMax ? `${value.slice(0, descriptionFallbackMax)}…` : value
}

/**
 * Fallback description when a skill has no frontmatter: prefer the first prose
 * line, skipping markdown heading lines (`# ...`). If the body is only
 * headings, fall back to the first heading text.
 */
function firstNonEmptyLine(body: string): string {
  let headingFallback = ''
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('#')) {
      if (!headingFallback) {
        headingFallback = line.replace(/^#+\s*/, '').trim()
      }
      continue
    }
    return cap(line)
  }
  return cap(headingFallback)
}

/**
 * Skill root directories, in precedence order. Earlier roots win on name
 * collision: explicit env path overrides the user home dir, which overrides
 * the repo-bundled dir. Each entry is existence-guarded by the caller.
 */
export function skillRoots(): string[] {
  const roots: string[] = []
  const envPath = process.env.JIANDANLY_LOCAL_SKILLS_PATH?.trim()
  if (envPath) {
    for (const entry of envPath.split(delimiter)) {
      const trimmed = entry.trim()
      if (trimmed) {
        roots.push(trimmed)
      }
    }
  }
  // Strict isolation: only the explicit env path participates (no home or
  // bundled roots). Opt-in for users who want a sealed skill set, and used by
  // tests to keep discovery hermetic regardless of machine state.
  const isolate = process.env.JIANDANLY_LOCAL_SKILLS_ISOLATE?.trim().toLowerCase()
  if (isolate === '1' || isolate === 'true') {
    return roots
  }
  roots.push(join(homedir(), '.jiandanly', 'skills'))
  // Shared with the Claude Code ecosystem: `npx skills add -g -a claude-code`
  // installs land here, so the agent discovers freshly installed skills.
  roots.push(join(homedir(), '.claude', 'skills'))
  try {
    roots.push(fileURLToPath(new URL('../../skills/', import.meta.url)))
  } catch {
    // import.meta.url unavailable (e.g. exotic bundling) — bundled skills are optional.
  }
  return roots
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Scan the given roots for `<dir>/SKILL.md` files and return the catalog.
 * Robust by design: an unreadable root, missing SKILL.md, or malformed
 * frontmatter never throws — the offending entry is skipped. Names are
 * de-duplicated with first-seen-wins (precedence per `skillRoots`).
 */
export function discoverSkills(roots: string[]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>()
  for (const root of roots) {
    if (!root || !existsSync(root) || !isDirectory(root)) {
      continue
    }
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      const dir = join(root, entry)
      const skillFile = join(dir, 'SKILL.md')
      if (!isDirectory(dir) || !existsSync(skillFile)) {
        continue
      }
      let raw: string
      try {
        raw = readFileSync(skillFile, 'utf8')
      } catch {
        continue
      }
      const parsed = parseSkillFrontmatter(raw)
      const name = (parsed.name ?? entry).trim()
      if (!name) {
        continue
      }
      const description = (parsed.description ?? firstNonEmptyLine(parsed.body)).trim()
      if (byName.has(name)) {
        continue
      }
      byName.set(name, { name, description, path: skillFile })
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Load one skill's full instructions by exact name. Returns null when the
 * skill is unknown or unreadable. Body is truncated to `maxBytes` with an
 * explicit notice so the tool result stays within its maxResultSize budget.
 */
export function loadSkill(roots: string[], name: string, maxBytes = 16384): SkillDetail | null {
  const target = name.trim()
  if (!target) {
    return null
  }
  const summary = discoverSkills(roots).find((skill) => skill.name === target)
  if (!summary) {
    return null
  }
  let raw: string
  try {
    raw = readFileSync(summary.path, 'utf8')
  } catch {
    return null
  }
  let body = raw.replace(/\r\n/g, '\n')
  if (Buffer.byteLength(body) > maxBytes) {
    body = `${body.slice(0, maxBytes)}\n\n[skill instructions truncated at ${maxBytes} bytes]`
  }
  return { ...summary, body }
}
