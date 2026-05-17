import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/shared/i18n/i18n'
import { SkillsView } from './SkillsView'
import type { InstalledSkill, RegistrySkill } from '@/shared/local-host/client'

afterEach(cleanup)

function renderView(overrides: Partial<Parameters<typeof SkillsView>[0]> = {}) {
  const props = {
    searchRegistry: vi.fn().mockResolvedValue({ skills: [] as RegistrySkill[] }),
    listInstalled: vi.fn().mockResolvedValue([] as InstalledSkill[]),
    installSkill: vi.fn().mockResolvedValue({ ok: true }),
    onCreateSkill: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider>
      <SkillsView {...props} />
    </I18nProvider>,
  )
  return props
}

function installedFixture(count: number): InstalledSkill[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `installed-${index}`,
    description: `desc ${index}`,
    path: `/p/${index}`,
  }))
}

describe('SkillsView — installed list (primary)', () => {
  it('renders installed skills with pagination', async () => {
    renderView({ listInstalled: vi.fn().mockResolvedValue(installedFixture(11)) })

    expect(await screen.findByText('installed-0')).toBeInTheDocument()
    expect(screen.getByText('installed-8')).toBeInTheDocument()
    expect(screen.queryByText('installed-9')).not.toBeInTheDocument()
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('installed-10')).toBeInTheDocument()
    expect(screen.queryByText('installed-0')).not.toBeInTheDocument()
  })

  it('filters the installed list and resets to page 1', async () => {
    renderView({ listInstalled: vi.fn().mockResolvedValue(installedFixture(11)) })
    await screen.findByText('installed-0')

    fireEvent.change(screen.getByLabelText('筛选已安装的技能…'), { target: { value: 'installed-10' } })

    expect(await screen.findByText('installed-10')).toBeInTheDocument()
    expect(screen.queryByText('installed-0')).not.toBeInTheDocument()
    expect(screen.queryByText('第 1 / 2 页')).not.toBeInTheDocument()
    expect(screen.getByText('共 11 个 · 筛出 1 个')).toBeInTheDocument()
  })

  it('shows an empty state with install + create CTAs when nothing is installed', async () => {
    renderView()
    expect(await screen.findByText('还没有安装任何技能。安装现成技能，或创建你自己的。')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '安装技能' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '创建技能' }).length).toBeGreaterThan(0)
  })
})

describe('SkillsView — install dialog', () => {
  it('searches and installs from the install dialog', async () => {
    const searchRegistry = vi.fn().mockResolvedValue({
      skills: [{ id: 'a/b/c', skillId: 'c', name: 'Cool Skill', installs: 12, source: 'a/b' }],
    })
    const installSkill = vi.fn().mockResolvedValue({ ok: true })
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce(installedFixture(2))
      .mockResolvedValue([...installedFixture(2), { name: 'c', description: 'cool', path: '/p/c' }])
    renderView({ searchRegistry, installSkill, listInstalled })
    await screen.findByText('installed-0')

    fireEvent.click(screen.getByRole('button', { name: '安装技能' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'cool' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索' }))

    expect(await within(dialog).findByText('Cool Skill')).toBeInTheDocument()
    expect(within(dialog).getByText('a/b')).toBeInTheDocument()
    expect(within(dialog).getByText('12 次安装')).toBeInTheDocument()
    expect(searchRegistry).toHaveBeenCalledWith('cool')

    fireEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    await waitFor(() => expect(installSkill).toHaveBeenCalledWith({ source: 'a/b', skillId: 'c' }))
    expect(await within(dialog).findByRole('button', { name: '已安装' })).toBeDisabled()
  })

  it('paginates registry results inside the dialog', async () => {
    const skills = Array.from({ length: 14 }, (_, index) => ({
      id: `s/${index}`,
      skillId: `skill-${index}`,
      name: `Skill ${index}`,
      installs: index,
      source: 'owner/repo',
    }))
    renderView({
      searchRegistry: vi.fn().mockResolvedValue({ skills }),
      listInstalled: vi.fn().mockResolvedValue(installedFixture(1)),
    })
    await screen.findByText('installed-0')

    fireEvent.click(screen.getByRole('button', { name: '安装技能' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'all' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索' }))

    expect(await within(dialog).findByText('Skill 0')).toBeInTheDocument()
    expect(within(dialog).queryByText('Skill 9')).not.toBeInTheDocument()
    expect(within(dialog).getByText('第 1 / 2 页')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }))
    expect(await within(dialog).findByText('Skill 13')).toBeInTheDocument()
  })
})

describe('SkillsView — guided create dialog', () => {
  it('opens the create dialog with steps and passes the description', async () => {
    const onCreateSkill = vi.fn()
    renderView({ onCreateSkill, listInstalled: vi.fn().mockResolvedValue(installedFixture(1)) })
    await screen.findByText('installed-0')

    fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('描述你想要的技能')).toBeInTheDocument()
    expect(within(dialog).getByText('在对话里完善，自动落盘到技能目录')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'a skill that lints CSS' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '用 skill-creator 创建' }))
    expect(onCreateSkill).toHaveBeenCalledWith('a skill that lints CSS')
  })
})
