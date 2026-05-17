import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { discoverSkills, loadSkill, parseSkillFrontmatter, skillRoots } from './skillLoader.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiandanly-skillloader-'))
  tempDirs.push(dir)
  return dir
}

async function seed(root: string, dirName: string, content: string): Promise<void> {
  await mkdir(join(root, dirName), { recursive: true })
  await writeFile(join(root, dirName, 'SKILL.md'), content, 'utf8')
}

describe('skillRoots', () => {
  it('includes ~/.claude/skills after ~/.jiandanly/skills and before the bundled dir', () => {
    const previous = process.env.JIANDANLY_LOCAL_SKILLS_PATH
    delete process.env.JIANDANLY_LOCAL_SKILLS_PATH
    try {
      const roots = skillRoots()
      const jiandanly = roots.indexOf(join(homedir(), '.jiandanly', 'skills'))
      const claude = roots.indexOf(join(homedir(), '.claude', 'skills'))
      expect(jiandanly).toBeGreaterThanOrEqual(0)
      expect(claude).toBeGreaterThan(jiandanly)
      // bundled dir (if resolvable) comes last
      expect(claude).toBeLessThan(roots.length)
    } finally {
      if (previous !== undefined) {
        process.env.JIANDANLY_LOCAL_SKILLS_PATH = previous
      }
    }
  })
})

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from a YAML-ish frontmatter block', () => {
    const parsed = parseSkillFrontmatter('---\nname: hunt\ndescription: Diagnose before you fix\n---\nBody line one.\n')
    expect(parsed.name).toBe('hunt')
    expect(parsed.description).toBe('Diagnose before you fix')
    expect(parsed.body.trim()).toBe('Body line one.')
  })

  it('strips surrounding quotes from values', () => {
    const parsed = parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\nx')
    expect(parsed.name).toBe('quoted')
    expect(parsed.description).toBe('single')
  })

  it('returns the whole input as body when there is no frontmatter', () => {
    const parsed = parseSkillFrontmatter('# Just markdown\nNo frontmatter here.')
    expect(parsed.name).toBeUndefined()
    expect(parsed.description).toBeUndefined()
    expect(parsed.body).toContain('Just markdown')
  })
})

describe('discoverSkills', () => {
  it('discovers skills and falls back to dir name + first body line when frontmatter is absent', async () => {
    const root = await tempRoot()
    await seed(root, 'with-fm', '---\nname: alpha\ndescription: Alpha skill\n---\nDo alpha things.')
    await seed(root, 'no-fm', '# Heading\nFirst meaningful line of the skill.')
    const skills = discoverSkills([root])
    expect(skills.find((s) => s.name === 'alpha')?.description).toBe('Alpha skill')
    const fallback = skills.find((s) => s.name === 'no-fm')
    expect(fallback).toBeDefined()
    expect(fallback?.description).toBe('First meaningful line of the skill.')
  })

  it('skips directories without SKILL.md and tolerates a missing root', () => {
    expect(discoverSkills(['/nonexistent/path/that/should/not/exist'])).toEqual([])
  })

  it('de-duplicates by name with first-root-wins precedence', async () => {
    const high = await tempRoot()
    const low = await tempRoot()
    await seed(high, 'shared', '---\nname: shared\ndescription: HIGH precedence\n---\nhigh body')
    await seed(low, 'shared', '---\nname: shared\ndescription: LOW precedence\n---\nlow body')
    const skills = discoverSkills([high, low])
    const shared = skills.filter((s) => s.name === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0].description).toBe('HIGH precedence')
  })
})

describe('loadSkill', () => {
  it('returns the full body for a known skill', async () => {
    const root = await tempRoot()
    await seed(root, 'deploy', '---\nname: deploy\ndescription: Deploy it\n---\nStep one. Step two.')
    const detail = loadSkill([root], 'deploy')
    expect(detail?.name).toBe('deploy')
    expect(detail?.body).toContain('Step one. Step two.')
  })

  it('returns null for an unknown skill name', async () => {
    const root = await tempRoot()
    await seed(root, 'deploy', '---\nname: deploy\ndescription: Deploy it\n---\nbody')
    expect(loadSkill([root], 'ghost')).toBeNull()
  })

  it('truncates an oversized body to the byte budget with a notice', async () => {
    const root = await tempRoot()
    const big = 'A'.repeat(5000)
    await seed(root, 'huge', `---\nname: huge\ndescription: Big skill\n---\n${big}`)
    const detail = loadSkill([root], 'huge', 1024)
    expect(detail).toBeTruthy()
    expect(detail!.body).toContain('[skill instructions truncated at 1024 bytes]')
    expect(Buffer.byteLength(detail!.body)).toBeLessThan(1200)
  })
})
