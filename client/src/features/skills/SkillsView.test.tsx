import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { SkillsView } from './SkillsView'
import type { InstalledSkill, SkillCatalog } from '@/shared/local-host/client'

afterEach(cleanup)

const shejaneRoot = { source: 'shejane', path: '/u/.shejane/skills' }
const claudeRoot = { source: 'claude', path: '/u/.claude/skills' }

const shejaneSkill: InstalledSkill = {
  name: 'my-skill',
  description: 'mine here',
  path: '/u/.shejane/skills/my-skill/SKILL.md',
  source: 'shejane',
  root_path: '/u/.shejane/skills',
}

const claudeSkill: InstalledSkill = {
  name: 'claude-skill',
  description: 'from claude',
  path: '/u/.claude/skills/claude-skill/SKILL.md',
  source: 'claude',
  root_path: '/u/.claude/skills',
}

function catalog(skills: InstalledSkill[], roots = [claudeRoot, shejaneRoot]): SkillCatalog {
  return { skills, roots }
}

function renderView(overrides: Partial<Parameters<typeof SkillsView>[0]> = {}) {
  const props = {
    listInstalled: vi.fn().mockResolvedValue(catalog([])),
    ...overrides,
  }
  render(
    <I18nProvider>
      <SkillsView {...props} />
    </I18nProvider>,
  )
  return props
}

describe('SkillsView — grouped catalog', () => {
  it('always renders every known root, even when its skills list is empty', async () => {
    renderView({
      listInstalled: vi.fn().mockResolvedValue(catalog([])),
    })
    // Both sections appear with empty-state hints — that's the whole
    // point of returning `roots` separately. Previously the Personal
    // section silently vanished when ~/.shejane/skills was empty and
    // the user had no idea where to drop files.
    expect(await screen.findByText('系统')).toBeInTheDocument()
    expect(screen.getByText('个人')).toBeInTheDocument()
    expect(
      screen.getByText(/\.claude\/skills.+刷新/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/\.shejane\/skills.+刷新/),
    ).toBeInTheDocument()
  })

  it('renders 系统 before 个人 even when input order is reversed', async () => {
    renderView({
      listInstalled: vi
        .fn()
        .mockResolvedValue(catalog([shejaneSkill, claudeSkill], [shejaneRoot, claudeRoot])),
    })
    const system = await screen.findByText('系统')
    const personal = screen.getByText('个人')
    expect(system.compareDocumentPosition(personal)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(screen.getByText('my-skill')).toBeInTheDocument()
    expect(screen.getByText('claude-skill')).toBeInTheDocument()
  })

  it('exposes one Open-folder icon button per section when the bridge is wired', async () => {
    const onOpenFolder = vi.fn()
    renderView({
      onOpenFolder,
      listInstalled: vi.fn().mockResolvedValue(catalog([shejaneSkill, claudeSkill])),
    })
    const buttons = await screen.findAllByRole('button', { name: '打开文件夹' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    expect(onOpenFolder).toHaveBeenCalledWith('/u/.claude/skills')
  })

  it('omits Open-folder buttons when no bridge is provided', async () => {
    renderView({
      listInstalled: vi.fn().mockResolvedValue(catalog([shejaneSkill])),
    })
    await screen.findByText('my-skill')
    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument()
  })

  it('hides the search box when no skills exist (nothing to filter)', async () => {
    renderView({ listInstalled: vi.fn().mockResolvedValue(catalog([])) })
    await screen.findByText('系统')
    expect(screen.queryByLabelText('搜索技能')).not.toBeInTheDocument()
  })

  it('filters skills by search query and shows 找不到技能 on empty match', async () => {
    renderView({
      listInstalled: vi.fn().mockResolvedValue(catalog([shejaneSkill, claudeSkill])),
    })
    await screen.findByText('my-skill')
    fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: 'nonexistent' } })
    expect(await screen.findByText('找不到技能')).toBeInTheDocument()
    expect(screen.queryByText('my-skill')).not.toBeInTheDocument()
    expect(screen.queryByText('claude-skill')).not.toBeInTheDocument()
  })

  it('refresh button re-invokes listInstalled', async () => {
    const listInstalled = vi.fn().mockResolvedValue(catalog([]))
    renderView({ listInstalled })
    await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => expect(listInstalled).toHaveBeenCalledTimes(2))
  })
})
