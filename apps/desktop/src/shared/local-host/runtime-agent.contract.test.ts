import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  answerLocalQuestionCommand,
  authorizeLocalWorkspace,
  cancelLocalRunCommand,
  createLocalRun,
  resolveLocalPermissionCommand,
  revokeLocalWorkspace,
  streamLocalRun,
} from './client'

const BASE_URL = process.env.VITE_TEST_LOCAL_HOST_URL
const TOKEN = process.env.VITE_TEST_LOCAL_HOST_TOKEN ?? 'dev-local-token'
const SETTINGS = { memory: 'off', skills: 'off', mcp: 'off' } as const

describe.skipIf(!BASE_URL)('contract: Runtime agent loop (live daemon)', () => {
  const config = { baseURL: BASE_URL!, token: TOKEN }

  it('reads a PDF attachment through a tool before completing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shejane-e2e-pdf-'))
    const attachment = join(directory, 'e2e-receipt.pdf')
    writeFileSync(attachment, minimalPdf('E2E rental receipt'))
    try {
      const suffix = Date.now().toString(36)
      const run = await createLocalRun({
        commandId: `cmd_e2e_pdf_${suffix}`,
        clientMessageId: `msg_e2e_pdf_${suffix}`,
        goal: '[[e2e:read-attachment]] summarize the attached PDF',
        attachmentPaths: [attachment],
        mode: 'local:test:model',
        settings: SETTINGS,
      }, config)
      const events: Array<{ type: string; payload: Record<string, unknown> }> = []
      await streamLocalRun(run.id, config, {
        onEvent: (event) => events.push({ type: event.event_type, payload: event.payload ?? {} }),
        onDelta: () => undefined,
      })

      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'tool.requested',
        'tool.completed',
        'run.completed',
      ]))
      const completed = events.find((event) => event.type === 'run.completed')
      expect(String(completed?.payload.final_text ?? '')).toContain('E2E rental receipt')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('pauses a write for permission and resumes after approval', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'shejane-e2e-write-'))
    let workspaceID = ''
    try {
      workspaceID = (await authorizeLocalWorkspace(workspace, config)).id
      const suffix = Date.now().toString(36)
      const run = await createLocalRun({
        commandId: `cmd_e2e_write_${suffix}`,
        clientMessageId: `msg_e2e_write_${suffix}`,
        goal: '[[e2e:write-file]] create the approved file',
        workspacePath: workspace,
        mode: 'local:test:model',
        settings: SETTINGS,
      }, config)
      const first: Array<{ type: string; payload: Record<string, unknown> }> = []
      await streamLocalRun(run.id, config, {
        onEvent: (event) => first.push({ type: event.event_type, payload: event.payload ?? {} }),
        onDelta: () => undefined,
      })
      expect(first.map((event) => event.type)).toEqual(expect.arrayContaining([
        'permission.required',
        'run.waiting',
      ]))
      const permission = first.find((event) => event.type === 'permission.required')
      const permissionID = String(permission?.payload.request_id ?? '')
      expect(permissionID).toBeTruthy()

      await expect(resolveLocalPermissionCommand(
        `cmd_e2e_approve_${suffix}`,
        permissionID,
        'approve',
        { scope: 'once' },
        config,
      )).resolves.toMatchObject({ resolved: true, resumed: true })

      const second: Array<{ type: string; payload: Record<string, unknown> }> = []
      await streamLocalRun(run.id, config, {
        onEvent: (event) => second.push({ type: event.event_type, payload: event.payload ?? {} }),
        onDelta: () => undefined,
      })
      expect(second.map((event) => event.type)).toEqual(expect.arrayContaining([
        'permission.resolved',
        'tool.completed',
        'run.completed',
      ]))
      const output = join(workspace, 'approved.txt')
      expect(existsSync(output)).toBe(true)
      expect(readFileSync(output, 'utf8')).toBe('approved by E2E')
    } finally {
      if (workspaceID) await revokeLocalWorkspace(workspaceID, config).catch(() => undefined)
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('pauses for a user answer and resumes with the typed decision', async () => {
    const suffix = Date.now().toString(36)
    const run = await createLocalRun({
      commandId: `cmd_e2e_question_${suffix}`,
      clientMessageId: `msg_e2e_question_${suffix}`,
      goal: '[[e2e:ask]] ask which option to use',
      mode: 'local:test:model',
      settings: SETTINGS,
    }, config)
    const first: Array<{ type: string; payload: Record<string, unknown> }> = []
    await streamLocalRun(run.id, config, {
      onEvent: (event) => first.push({ type: event.event_type, payload: event.payload ?? {} }),
      onDelta: () => undefined,
    })
    const question = first.find((event) => event.type === 'question.asked')
    const questionID = String(question?.payload.request_id ?? '')
    expect(questionID).toBeTruthy()
    expect(first.map((event) => event.type)).toContain('run.waiting')

    await expect(answerLocalQuestionCommand(
      `cmd_e2e_answer_${suffix}`,
      questionID,
      { [questionID]: ['Option B'] },
      config,
    )).resolves.toMatchObject({ answered: true, resumed: true })

    const second: Array<{ type: string; payload: Record<string, unknown> }> = []
    await streamLocalRun(run.id, config, {
      onEvent: (event) => second.push({ type: event.event_type, payload: event.payload ?? {} }),
      onDelta: () => undefined,
    })
    expect(second.map((event) => event.type)).toEqual(expect.arrayContaining([
      'question.answered',
      'run.completed',
    ]))
    const completed = second.find((event) => event.type === 'run.completed')
    expect(String(completed?.payload.final_text ?? '')).toContain('Option B')
  })

  it('cancels an in-flight model call and reaches a durable terminal state', async () => {
    const suffix = Date.now().toString(36)
    const run = await createLocalRun({
      commandId: `cmd_e2e_slow_${suffix}`,
      clientMessageId: `msg_e2e_slow_${suffix}`,
      goal: '[[e2e:slow]] keep running until canceled',
      mode: 'local:test:model',
      settings: SETTINGS,
    }, config)
    const events: string[] = []
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const stream = streamLocalRun(run.id, config, {
      onEvent: (event) => {
        events.push(event.event_type)
        if (event.event_type === 'run.started') markStarted()
      },
      onDelta: () => undefined,
    })
    await started
    await expect(cancelLocalRunCommand(
      `cmd_e2e_cancel_${suffix}`,
      run.id,
      config,
    )).resolves.toMatchObject({ canceled: true })
    await stream

    expect(events).toContain('run.canceled')
    expect(events).not.toContain('run.completed')
  })
})

function minimalPdf(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'ascii')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream', 'ascii'),
    ]),
  ]
  const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')]
  const offsets = [0]
  let length = chunks[0].length
  objects.forEach((object, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      object,
      Buffer.from('\nendobj\n', 'ascii'),
    ])
    chunks.push(chunk)
    length += chunk.length
  })
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join('')
  chunks.push(Buffer.from(xref, 'ascii'))
  return Buffer.concat(chunks)
}
