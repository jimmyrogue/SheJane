import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  authorizeLocalWorkspace,
  createMcpServer,
  createLocalRun,
  deleteMcpServer,
  listMcpServers,
  resolveLocalPermissionCommand,
  revokeLocalWorkspace,
  streamLocalRun,
} from './client'

const BASE_URL = process.env.VITE_TEST_LOCAL_HOST_URL
const TOKEN = process.env.VITE_TEST_LOCAL_HOST_TOKEN ?? 'dev-local-token'
const DEFAULT_SETTINGS = { memory: 'off', skills: 'off', mcp: 'off' } as const
const MEMORY_SETTINGS = { ...DEFAULT_SETTINGS, memory: 'on' } as const
const DEDICATED_TOOL_TESTS = ['read_file', 'write_file', 'user.ask'] as const

type ToolCase = {
  name: string
  args: (workspace: string) => Record<string, unknown>
  expected: string
  instruction?: string
  goal?: string
  outcome?: 'completed' | 'failed'
  settings?: typeof DEFAULT_SETTINGS | typeof MEMORY_SETTINGS
  verify?: (workspace: string) => void
}

const TOOL_CASES: ToolCase[] = [
  { name: 'time.now', args: () => ({ timezone: 'UTC' }), expected: 'UTC' },
  { name: 'environment.observe', args: () => ({}), expected: 'python' },
  { name: 'ls', args: () => ({ path: '/' }), expected: 'notes.txt' },
  { name: 'glob', args: () => ({ pattern: '*.txt', path: '/' }), expected: 'notes.txt' },
  {
    name: 'grep',
    args: () => ({ pattern: 'E2E needle', path: '/', output_mode: 'content' }),
    expected: 'E2E needle',
  },
  {
    name: 'edit_file',
    args: () => ({ file_path: '/edit.txt', old_string: 'before', new_string: 'after' }),
    expected: 'Successfully replaced',
    verify: workspace => expect(readFileSync(join(workspace, 'edit.txt'), 'utf8')).toBe('after'),
  },
  { name: 'execute', args: () => ({ command: 'printf e2e-execute' }), expected: 'e2e-execute' },
  {
    name: 'task.verify',
    args: () => ({
      checks: [{ kind: 'file_contains', path: 'notes.txt', substring: 'E2E needle' }],
    }),
    expected: 'pass_count',
  },
  {
    name: 'task.progress',
    args: () => ({ summary: 'E2E progress recorded', status: 'verified' }),
    expected: 'E2E progress recorded',
  },
  {
    name: 'memory.write',
    args: () => ({ fact: 'E2E memory fact.' }),
    expected: 'saved',
    goal: 'Please remember that E2E memory fact.',
    settings: MEMORY_SETTINGS,
  },
  {
    name: 'memory.search',
    args: () => ({ query: 'E2E memory fact.' }),
    expected: 'E2E memory fact.',
    settings: MEMORY_SETTINGS,
  },
  {
    name: 'web.fetch',
    args: () => ({ url: 'http://127.0.0.1/private' }),
    expected: 'refusing private/loopback address',
    outcome: 'failed',
  },
  {
    name: 'open.url',
    args: () => ({ url: 'file:///tmp/blocked' }),
    expected: 'only http(s)',
    outcome: 'failed',
  },
  {
    name: 'open.file',
    args: () => ({ path: '/missing-e2e-file' }),
    expected: 'file not found',
    outcome: 'failed',
  },
  { name: 'clipboard.write', args: () => ({ text: 'E2E' }), expected: 'bytes_written' },
  { name: 'clipboard.read', args: () => ({}), expected: 'text' },
  {
    name: 'office.read',
    args: workspace => ({ path: join(workspace, 'base.docx') }),
    expected: 'E2E heading',
  },
  {
    name: 'office.outline',
    args: workspace => ({ path: join(workspace, 'base.docx') }),
    expected: 'paragraph_count',
  },
  {
    name: 'office.read_range',
    args: workspace => ({ path: join(workspace, 'base.xlsx'), sheet: 'Data', range: 'A1:B2' }),
    expected: 'Needle',
  },
  {
    name: 'office.read_slides',
    args: workspace => ({ path: join(workspace, 'base.pptx') }),
    expected: 'E2E Deck',
  },
  officeWriteCase('office.find_replace', 'docx', workspace => ({
    path: freshOfficeFile(workspace, 'office.find_replace', 'docx'),
    find: 'Replace target',
    replace: 'Replaced E2E',
  }), '"replaced": 1'),
  officeWriteCase('office.insert_paragraph', 'docx', workspace => ({
    path: freshOfficeFile(workspace, 'office.insert_paragraph', 'docx'),
    anchor: 'Replace target',
    content: 'Inserted E2E',
    position: 'after',
  }), 'after anchor'),
  officeWriteCase('office.update_paragraph', 'docx', workspace => ({
    path: freshOfficeFile(workspace, 'office.update_paragraph', 'docx'),
    target: 'Update target',
    content: 'Updated E2E',
  }), 'Update target'),
  officeWriteCase('office.delete_paragraph', 'docx', workspace => ({
    path: freshOfficeFile(workspace, 'office.delete_paragraph', 'docx'),
    target: 'Delete target',
  }), 'Delete target'),
  officeWriteCase('office.apply_style', 'docx', workspace => ({
    path: freshOfficeFile(workspace, 'office.apply_style', 'docx'),
    target: 'Style target',
    style: 'Heading 2',
  }), 'Heading 2'),
  officeWriteCase('office.set_cells', 'xlsx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_cells', 'xlsx'),
    sheet: 'Data',
    range: 'C1:C2',
    values: [['Extra'], ['E2E']],
  }), 'C1:C2'),
  officeWriteCase('office.set_formula', 'xlsx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_formula', 'xlsx'),
    sheet: 'Data',
    cell: 'C2',
    formula: '=B2*2',
  }), '=B2*2'),
  officeWriteCase('office.set_cell_format', 'xlsx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_cell_format', 'xlsx'),
    sheet: 'Data',
    range: 'A1:B1',
    bold: true,
    bg_color: '#FFF2CC',
  }), 'cells_formatted'),
  officeWriteCase('office.merge_cells', 'xlsx', workspace => ({
    path: freshOfficeFile(workspace, 'office.merge_cells', 'xlsx'),
    sheet: 'Data',
    range: 'A3:B3',
  }), 'A3:B3'),
  officeWriteCase('office.add_row', 'xlsx', workspace => ({
    path: freshOfficeFile(workspace, 'office.add_row', 'xlsx'),
    sheet: 'Data',
    values: ['Added', 3],
  }), 'cells_written'),
  {
    name: 'office.create_pptx',
    args: (workspace) => {
      const path = officePath(workspace, 'office.create_pptx', 'pptx')
      rmSync(path, { force: true })
      return { path, title: 'E2E Created Deck' }
    },
    expected: 'E2E Created Deck',
    verify: workspace => expect(existsSync(officePath(workspace, 'office.create_pptx', 'pptx'))).toBe(true),
  },
  officeWriteCase('office.add_slide', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.add_slide', 'pptx'),
    title: 'Added slide',
    bullets: ['One', 'Two'],
  }), 'Title and Content'),
  officeWriteCase('office.update_slide', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.update_slide', 'pptx'),
    index: 0,
    title: 'Updated slide',
  }), '"index": 0'),
  officeWriteCase('office.delete_slide', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.delete_slide', 'pptx'),
    index: 1,
  }), 'Second slide'),
  officeWriteCase('office.reorder_slides', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.reorder_slides', 'pptx'),
    from_index: 0,
    to_index: 1,
  }), 'from_index'),
  officeWriteCase('office.set_slide_title', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_slide_title', 'pptx'),
    index: 0,
    title: 'Retitled E2E',
  }), '"index": 0'),
  officeWriteCase('office.set_slide_bullets', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_slide_bullets', 'pptx'),
    index: 1,
    bullets: ['Updated bullet'],
  }), '"index": 1'),
  officeWriteCase('office.set_slide_notes', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.set_slide_notes', 'pptx'),
    index: 0,
    notes: 'E2E speaker notes',
  }), 'E2E speaker notes'),
  officeWriteCase('office.add_image_to_slide', 'pptx', workspace => ({
    path: freshOfficeFile(workspace, 'office.add_image_to_slide', 'pptx'),
    index: 0,
    image_path: join(workspace, 'pixel.png'),
    width_in: 1,
  }), 'pixel.png'),
]

describe.skipIf(!BASE_URL)('contract: every Runtime Tool (live daemon)', () => {
  const config = { baseURL: BASE_URL!, token: TOKEN }
  const workspace = mkdtempSync(join(tmpdir(), 'shejane-e2e-tools-'))
  let workspaceID = ''

  beforeAll(async () => {
    writeFileSync(join(workspace, 'notes.txt'), 'E2E needle\n')
    writeFileSync(join(workspace, 'edit.txt'), 'before')
    createOfficeFixtures(workspace)
    workspaceID = (await authorizeLocalWorkspace(workspace, config)).id
  })

  afterAll(async () => {
    if (workspaceID) await revokeLocalWorkspace(workspaceID, config).catch(() => undefined)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('keeps every published Tool on an executed E2E path', async () => {
    const response = await fetch(`${BASE_URL}/local/v1/tools`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { tools: Array<{ name: string }> }
    const published = body.tools.map((tool) => tool.name).sort()
    const executed = [...TOOL_CASES.map((tool) => tool.name), ...DEDICATED_TOOL_TESTS].sort()
    expect(executed).toEqual(published)
  })

  it.each(TOOL_CASES)('executes $name through the complete agent loop', async (toolCase) => {
    const args = toolCase.args(workspace)
    const suffix = `${Date.now().toString(36)}_${toolCase.name.replaceAll('.', '_')}`
    const run = await createLocalRun({
      commandId: `cmd_e2e_tool_${suffix}`,
      clientMessageId: `msg_e2e_tool_${suffix}`,
      goal: toolCase.goal ?? encodedToolGoal(toolCase.name, args, toolCase.instruction),
      workspacePath: workspace,
      mode: 'local:test:model',
      settings: toolCase.settings ?? DEFAULT_SETTINGS,
    }, config)
    const events = await streamThroughPermission(run.id, suffix, config)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool.requested',
        payload: expect.objectContaining({ name: toolCase.name }),
      }),
      expect.objectContaining({
        type: `tool.${toolCase.outcome ?? 'completed'}`,
        payload: expect.objectContaining({ name: toolCase.name }),
      }),
      expect.objectContaining({ type: 'run.completed' }),
    ]))
    const completed = [...events].reverse().find(event => event.type === 'run.completed')
    expect(String(completed?.payload.final_text ?? '')).toContain(toolCase.expected)
    toolCase.verify?.(workspace)
  })

  it('searches and executes a configured stdio MCP Tool', async () => {
    const serverName = 'e2e-runtime-mcp'
    const toolName = `${serverName}_echo`
    const runtimeRoot = resolve(process.cwd(), '../../services/runtime')
    const suffix = Date.now().toString(36)
    await deleteMcpServer(serverName, config).catch(() => undefined)
    try {
      await createMcpServer({
        name: serverName,
        transport: 'stdio',
        command: 'uv',
        args: ['run', 'python', 'tests/fixtures/e2e_mcp_server.py'],
        env: {},
        cwd: runtimeRoot,
      }, config)
      await waitForMcpServer(serverName, config)

      const searchRun = await createLocalRun({
        commandId: `cmd_e2e_mcp_search_${suffix}`,
        clientMessageId: `msg_e2e_mcp_search_${suffix}`,
        goal: encodedToolGoal('mcp.search_tools', { query: 'echo', limit: 3 }),
        workspacePath: workspace,
        mode: 'local:test:model',
        settings: { ...DEFAULT_SETTINGS, mcp: 'on' },
      }, config)
      const searchEvents = await streamThroughPermission(searchRun.id, `search_${suffix}`, config)
      expect(searchEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.requested',
          payload: expect.objectContaining({ name: 'mcp.search_tools' }),
        }),
        expect.objectContaining({
          type: 'tool.completed',
          payload: expect.objectContaining({ name: 'mcp.search_tools' }),
        }),
        expect.objectContaining({ type: 'run.completed' }),
      ]))
      const searchCompleted = [...searchEvents]
        .reverse()
        .find(event => event.type === 'run.completed')
      expect(String(searchCompleted?.payload.final_text ?? '')).toContain(toolName)

      const run = await createLocalRun({
        commandId: `cmd_e2e_mcp_${suffix}`,
        clientMessageId: `msg_e2e_mcp_${suffix}`,
        goal: encodedToolGoal(toolName, { value: 'ping' }),
        workspacePath: workspace,
        mode: 'local:test:model',
        settings: { ...DEFAULT_SETTINGS, mcp: 'on' },
      }, config)
      const events = await streamThroughPermission(run.id, suffix, config)

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.requested',
          payload: expect.objectContaining({ name: toolName }),
        }),
        expect.objectContaining({
          type: 'tool.completed',
          payload: expect.objectContaining({ name: toolName }),
        }),
        expect.objectContaining({ type: 'run.completed' }),
      ]))
      const completed = [...events].reverse().find(event => event.type === 'run.completed')
      expect(String(completed?.payload.final_text ?? '')).toContain('E2E_MCP_OK:ping')
    } finally {
      await deleteMcpServer(serverName, config).catch(() => undefined)
    }
  })
})

type RuntimeEvent = { type: string; payload: Record<string, unknown> }
type RuntimeConfig = { baseURL: string; token: string }

async function waitForMcpServer(name: string, config: RuntimeConfig): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = (await listMcpServers(config)).servers.find(item => item.name === name)
    if (server?.status === 'ready' && server.tool_count > 0) return
    if (server?.status === 'error') throw new Error(`MCP discovery failed: ${server.error_type}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`MCP server ${name} did not become ready`)
}

async function streamThroughPermission(
  runID: string,
  suffix: string,
  config: RuntimeConfig,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  await collectRunEvents(runID, config, events)
  const permission = events.find(event => event.type === 'permission.required')
  if (permission) {
    const permissionID = String(permission.payload.request_id ?? '')
    expect(permissionID).toBeTruthy()
    await resolveLocalPermissionCommand(
      `cmd_e2e_tool_approve_${suffix}`,
      permissionID,
      'approve',
      { scope: 'once' },
      config,
    )
    await collectRunEvents(runID, config, events)
  }
  return events
}

async function collectRunEvents(
  runID: string,
  config: RuntimeConfig,
  events: RuntimeEvent[],
): Promise<void> {
  await streamLocalRun(runID, config, {
    onEvent: event => events.push({ type: event.event_type, payload: event.payload ?? {} }),
    onDelta: () => undefined,
  })
}

function encodedToolGoal(
  name: string,
  args: Record<string, unknown>,
  instruction = `Use the ${name} Tool.`,
): string {
  const payload = Buffer.from(JSON.stringify({ name, args }), 'utf8').toString('base64url')
  return `${instruction}\n[[e2e:tool:${payload}]]`
}

function officeWriteCase(
  name: string,
  extension: 'docx' | 'xlsx' | 'pptx',
  args: (workspace: string) => Record<string, unknown>,
  expected: string,
): ToolCase {
  return {
    name,
    args,
    expected,
    verify: workspace => expect(existsSync(editedOfficePath(workspace, name, extension))).toBe(true),
  }
}

function freshOfficeFile(
  workspace: string,
  name: string,
  extension: 'docx' | 'xlsx' | 'pptx',
): string {
  const path = officePath(workspace, name, extension)
  rmSync(editedOfficePath(workspace, name, extension), { force: true })
  copyFileSync(join(workspace, `base.${extension}`), path)
  return path
}

function officePath(workspace: string, name: string, extension: string): string {
  return join(workspace, `${name.replaceAll('.', '_')}.${extension}`)
}

function editedOfficePath(workspace: string, name: string, extension: string): string {
  return join(workspace, `${name.replaceAll('.', '_')}.edited.${extension}`)
}

function createOfficeFixtures(workspace: string): void {
  const script = `
import sys
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation

root = Path(sys.argv[1])
doc = Document()
doc.add_heading("E2E heading", level=1)
for text in ("Replace target", "Update target", "Delete target", "Style target"):
    doc.add_paragraph(text)
doc.save(root / "base.docx")

book = Workbook()
sheet = book.active
sheet.title = "Data"
sheet.append(["Name", "Value"])
sheet.append(["Needle", 2])
book.save(root / "base.xlsx")

deck = Presentation()
cover = deck.slides.add_slide(deck.slide_layouts[0])
cover.shapes.title.text = "E2E Deck"
second = deck.slides.add_slide(deck.slide_layouts[1])
second.shapes.title.text = "Second slide"
second.placeholders[1].text = "Initial bullet"
deck.save(root / "base.pptx")
`
  execFileSync('uv', ['run', 'python', '-c', script, workspace], {
    cwd: resolve(process.cwd(), '../../services/runtime'),
  })
  writeFileSync(
    join(workspace, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  )
}
