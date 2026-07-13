import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { I18nProvider } from '@/shared/i18n/i18n'
import type { LocalRunDiagnostics } from '@/shared/local-host/client'

afterEach(() => cleanup())

describe('DiagnosticsPanel', () => {
  it('surfaces the latest task verification status in the handoff summary', () => {
    renderPanel({
      handoff: {
        status: 'completed',
        headline: 'Run completed with verification.',
        ledger_state: 'fresh',
        ledger_message: null,
        next_actions: [],
        blockers: [],
        recent_event_types: ['tool.completed'],
        verification: {
          status: 'passed',
          reason: 'substring found',
          pass_count: 1,
          fail_count: 0,
          source_event_type: 'tool.completed',
        },
      },
    })

    expect(screen.getByText('验证结果')).toBeInTheDocument()
    expect(screen.getByText('验证通过')).toBeInTheDocument()
    expect(screen.getByText('通过 1')).toBeInTheDocument()
    expect(screen.getByText('失败 0')).toBeInTheDocument()
    expect(screen.getByText('substring found')).toBeInTheDocument()
  })

  it('localizes failure category and next action from the failure classification', () => {
    renderPanel({
      handoff: {
        status: 'failed',
        headline: 'Run failed.',
        ledger_state: 'not_required',
        ledger_message: null,
        next_actions: [
          'Inspect blockers and recent failed events before retrying.',
          'Check the Runtime provider credential, then retry.',
        ],
        blockers: [],
        recent_event_types: ['run.failed'],
        failure: {
          category: 'auth',
          recoverable: true,
          retryable: false,
          action_kind: 'user_action',
          recovery_action: 'diagnostics',
          code: 'unauthorized',
          message: 'provider credential rejected',
          source_event_type: 'run.failed',
          tool: null,
          suggested_action: 'Check the Runtime provider credential, then retry.',
        },
        verification: null,
      },
    })

    expect(screen.getByText('供应商凭据')).toBeInTheDocument()
    expect(screen.getByText('需要你处理')).toBeInTheDocument()
    expect(screen.getByText('请检查 Runtime 中的模型供应商凭据，然后重试。')).toBeInTheDocument()
    expect(screen.getByText('请先查看阻塞项和最近失败事件，再重试。')).toBeInTheDocument()
    expect(screen.queryByText('auth')).not.toBeInTheDocument()
    expect(screen.queryByText('需先处理')).not.toBeInTheDocument()
    expect(screen.queryByText(/Inspect blockers and recent failed events/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Sign in to the Electron app/)).not.toBeInTheDocument()
  })

  it('renders reflection stats and critic notes', () => {
    renderPanel({
      reflection: {
        ai_messages: 2,
        tool_results: 3,
        final_answer_chars: 144,
        critic: {
          coverage: 4,
          clarity: 5,
          grounding: 3,
          notes: ['cite source'],
          raw: null,
        },
      },
    })

    expect(screen.getByText('反思')).toBeInTheDocument()
    expect(screen.getByText('AI 2')).toBeInTheDocument()
    expect(screen.getByText('工具 3')).toBeInTheDocument()
    expect(screen.getByText('最终回答 144 字')).toBeInTheDocument()
    expect(screen.getByText('覆盖 4')).toBeInTheDocument()
    expect(screen.getByText('清晰 5')).toBeInTheDocument()
    expect(screen.getByText('依据 3')).toBeInTheDocument()
    expect(screen.getByText('cite source')).toBeInTheDocument()
  })

  it('offers a checkpoint fork action when a checkpoint is available', async () => {
    const onForkCheckpoint = vi.fn()
    renderPanel(
      {
        latest_checkpoint: {
          id: 'ckpt-1',
          run_id: 'run-1',
          step: 4,
          reason: 'loop',
          messages_count: 3,
          created_at: '2026-06-13T00:00:00Z',
        },
      },
      { onForkCheckpoint },
    )

    fireEvent.click(screen.getByRole('button', { name: '从这里重试' }))

    expect(onForkCheckpoint).toHaveBeenCalledWith('run-1', 'ckpt-1')
  })
})

function renderPanel(
  overrides: Partial<LocalRunDiagnostics> = {},
  props: { onForkCheckpoint?: (runID: string, checkpointID: string) => void } = {},
) {
  return render(
    <I18nProvider>
      <DiagnosticsPanel
        diagnostics={diagnostics(overrides)}
        onClose={() => undefined}
        onExport={() => undefined}
        onForkCheckpoint={props.onForkCheckpoint}
      />
    </I18nProvider>,
  )
}

function diagnostics(overrides: Partial<LocalRunDiagnostics> = {}): LocalRunDiagnostics {
  return {
    schema_version: 1,
    exported_at: '2026-06-11T00:00:00Z',
    local_host_version: null,
    run: {
      id: 'run-1',
      goal: 'Verify diagnostics',
      status: 'completed',
      created_at: '2026-06-11T00:00:00Z',
      updated_at: '2026-06-11T00:00:01Z',
      workspace_path: null,
      parent_run_id: null,
      history_json: '[]',
      settings_json: '{}',
      metadata_json: '{}',
    },
    events: [],
    permissions: [],
    artifacts: [],
    latest_checkpoint: null,
    handoff: {
      status: 'completed',
      headline: 'Run completed.',
      ledger_state: 'not_required',
      ledger_message: null,
      next_actions: [],
      blockers: [],
      recent_event_types: [],
      failure: null,
      verification: null,
    },
    feature_ledger: null,
    reflection: null,
    ...overrides,
  }
}
