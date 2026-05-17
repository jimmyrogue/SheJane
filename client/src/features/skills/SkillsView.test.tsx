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

describe('SkillsView', () => {
  it('searches the registry and renders result cards', async () => {
    const searchRegistry = vi.fn().mockResolvedValue({
      skills: [{ id: 'a/b/c', skillId: 'c', name: 'Cool Skill', installs: 12, source: 'a/b' }],
    })
    renderView({ searchRegistry })

    fireEvent.change(screen.getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'cool' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByText('Cool Skill')).toBeInTheDocument()
    expect(screen.getByText('a/b')).toBeInTheDocument()
    expect(screen.getByText('12 次安装')).toBeInTheDocument()
    expect(searchRegistry).toHaveBeenCalledWith('cool')
  })

  it('installs a skill and refreshes the installed list', async () => {
    const searchRegistry = vi.fn().mockResolvedValue({
      skills: [{ id: 'a/b/c', skillId: 'c', name: 'Cool Skill', installs: 1, source: 'a/b' }],
    })
    const installSkill = vi.fn().mockResolvedValue({ ok: true })
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ name: 'c', description: 'installed', path: '/p' }])
    renderView({ searchRegistry, installSkill, listInstalled })

    fireEvent.change(screen.getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'cool' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))

    await waitFor(() => expect(installSkill).toHaveBeenCalledWith({ source: 'a/b', skillId: 'c' }))
    expect(await screen.findByRole('button', { name: '已安装' })).toBeDisabled()
  })

  it('shows the install error when the install fails', async () => {
    const searchRegistry = vi.fn().mockResolvedValue({
      skills: [{ id: 'a/b/c', skillId: 'c', name: 'Cool Skill', installs: 1, source: 'a/b' }],
    })
    const installSkill = vi.fn().mockResolvedValue({ ok: false, stderr: 'network down' })
    renderView({ searchRegistry, installSkill })

    fireEvent.change(screen.getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'cool' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))

    expect(await screen.findByText(/network down/)).toBeInTheDocument()
  })

  it('opens the create dialog from the top button and passes the description', async () => {
    const onCreateSkill = vi.fn()
    renderView({ onCreateSkill })

    fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'a skill that lints CSS' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '用 skill-creator 创建' }))
    expect(onCreateSkill).toHaveBeenCalledWith('a skill that lints CSS')
  })

  it('paginates results into pages of nine', async () => {
    const skills = Array.from({ length: 14 }, (_, index) => ({
      id: `s/${index}`,
      skillId: `skill-${index}`,
      name: `Skill ${index}`,
      installs: index,
      source: 'owner/repo',
    }))
    const searchRegistry = vi.fn().mockResolvedValue({ skills })
    renderView({ searchRegistry })

    fireEvent.change(screen.getByLabelText('搜索技能（如 typescript、playwright）'), {
      target: { value: 'all' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByText('Skill 0')).toBeInTheDocument()
    expect(screen.getByText('Skill 8')).toBeInTheDocument()
    expect(screen.queryByText('Skill 9')).not.toBeInTheDocument()
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('Skill 13')).toBeInTheDocument()
    expect(screen.queryByText('Skill 0')).not.toBeInTheDocument()
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
  })

  it('paginates the installed skills list', async () => {
    const listInstalled = vi.fn().mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        name: `installed-${index}`,
        description: `desc ${index}`,
        path: `/p/${index}`,
      })),
    )
    renderView({ listInstalled })

    expect(await screen.findByText('installed-0')).toBeInTheDocument()
    expect(screen.getByText('installed-8')).toBeInTheDocument()
    expect(screen.queryByText('installed-9')).not.toBeInTheDocument()
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('installed-10')).toBeInTheDocument()
    expect(screen.queryByText('installed-0')).not.toBeInTheDocument()
  })
})
