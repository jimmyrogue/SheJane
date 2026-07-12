import { describe, expect, it } from 'vitest'
import type { LocalThreadSnapshot } from '../../shared/local-host/client'
import { projectRuntimeThread } from './runtimeProjection'

describe('Runtime thread projection', () => {
  it('rebuilds visible messages, metadata, statuses, and timeline from Runtime truth', () => {
    const snapshot: LocalThreadSnapshot = {
      thread: {
        id: 'conversation-1',
        title: 'Visible title',
        metadata: {
          pinned: true,
          workspace: { path: '/tmp/project', label: 'project', authorized: true },
        },
        version: 2,
        created_at: '2026-07-12T00:00:00Z',
        updated_at: '2026-07-12T00:00:02Z',
      },
      items: [
        {
          id: 'runtime-user',
          thread_id: 'conversation-1',
          run_id: 'run-1',
          client_id: 'user-1',
          item_type: 'user_message',
          status: 'completed',
          content: 'Visible question',
          metadata: { attachments: [{ documentId: 'doc-1', name: 'brief.pdf', contentType: 'application/pdf' }] },
          position: 1,
          version: 1,
          created_at: '2026-07-12T00:00:00Z',
          updated_at: '2026-07-12T00:00:00Z',
        },
        {
          id: 'assistant-1',
          thread_id: 'conversation-1',
          run_id: 'run-1',
          client_id: 'assistant-client-1',
          item_type: 'assistant_message',
          status: 'completed',
          content: 'Done',
          metadata: {},
          position: 2,
          version: 2,
          created_at: '2026-07-12T00:00:01Z',
          updated_at: '2026-07-12T00:00:02Z',
          completed_at: '2026-07-12T00:00:02Z',
        },
      ],
      runs: [{
        id: 'run-1',
        goal: 'Internal directive\nVisible question',
        user_input: 'Visible question',
        status: 'completed',
        thread_id: 'conversation-1',
        assistant_item_id: 'assistant-1',
        command_id: 'cmd-1',
        history_json: '[]',
        settings_json: '{}',
        metadata_json: '{}',
        created_at: '2026-07-12T00:00:00Z',
        updated_at: '2026-07-12T00:00:02Z',
      }],
      events: [{
        id: 'event-1',
        run_id: 'run-1',
        seq: 1,
        event_type: 'run.completed',
        payload: { final_text: 'Done' },
        created_at: '2026-07-12T00:00:02Z',
      }],
      cursor: 2,
      has_more_items: false,
      events_truncated: false,
    }

    const conversation = projectRuntimeThread(snapshot)

    expect(conversation).toMatchObject({
      id: 'conversation-1',
      title: 'Visible title',
      pinned: true,
      workspace: { path: '/tmp/project' },
    })
    expect(conversation.messages).toMatchObject([
      { id: 'user-1', role: 'user', content: 'Visible question', attachments: [{ documentId: 'doc-1' }] },
      {
        id: 'assistant-client-1',
        role: 'assistant',
        content: 'Done',
        status: 'done',
        runId: 'run-1',
        commandId: 'cmd-1',
        agentEvents: [{ type: 'run.completed' }],
      },
    ])
  })
})
