import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
          'Sign in to the Electron app or refresh the local cloud session, then retry.',
        ],
        blockers: [],
        recent_event_types: ['run.failed'],
        failure: {
          category: 'auth',
          recoverable: true,
          retryable: false,
          action_kind: 'user_action',
          code: 'cloud_session_required',
          message: 'cloud session required',
          source_event_type: 'run.failed',
          tool: null,
          suggested_action: 'Sign in to the Electron app or refresh the local cloud session, then retry.',
        },
        verification: null,
      },
    })

    expect(screen.getByText('登录状态')).toBeInTheDocument()
    expect(screen.getByText('需要你处理')).toBeInTheDocument()
    expect(screen.getByText('请重新登录或刷新本地云端会话，然后重试。')).toBeInTheDocument()
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
})

function renderPanel(overrides: Partial<LocalRunDiagnostics> = {}) {
  return render(
    <I18nProvider>
      <DiagnosticsPanel
        diagnostics={diagnostics(overrides)}
        onClose={() => undefined}
        onExport={() => undefined}
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
