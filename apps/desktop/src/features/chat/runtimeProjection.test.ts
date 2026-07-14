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
          metadata: {
            attachments: [{ path: '/tmp/brief.pdf', name: 'brief.pdf' }],
          },
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
      event_high_watermarks: { 'run-1': 9 },
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
      {
        id: 'user-1',
        role: 'user',
        content: 'Visible question',
        attachments: [{ path: '/tmp/brief.pdf', name: 'brief.pdf' }],
      },
      {
        id: 'assistant-client-1',
        role: 'assistant',
        content: 'Done',
        status: 'done',
        runId: 'run-1',
        commandId: 'cmd-1',
        lastEventSeq: 9,
        agentEvents: [{ type: 'run.completed' }],
      },
    ])
  })

  it('does not move a live client cursor backwards when an older snapshot arrives', () => {
    const snapshot: LocalThreadSnapshot = {
      thread: {
        id: 'conversation-live',
        title: 'Live',
        metadata: {},
        version: 1,
        created_at: '2026-07-12T00:00:00Z',
        updated_at: '2026-07-12T00:00:01Z',
      },
      items: [{
        id: 'assistant-live',
        thread_id: 'conversation-live',
        run_id: 'run-live',
        client_id: 'assistant-live-client',
        item_type: 'assistant_message',
        status: 'in_progress',
        content: '',
        metadata: {},
        position: 1,
        version: 1,
        created_at: '2026-07-12T00:00:00Z',
        updated_at: '2026-07-12T00:00:01Z',
      }],
      runs: [{
        id: 'run-live',
        goal: 'Live',
        status: 'running',
        thread_id: 'conversation-live',
        history_json: '[]',
        settings_json: '{}',
        metadata_json: '{}',
        created_at: '2026-07-12T00:00:00Z',
        updated_at: '2026-07-12T00:00:01Z',
      }],
      events: [],
      event_high_watermarks: { 'run-live': 0 },
      cursor: 1,
      has_more_items: false,
      events_truncated: false,
    }
    const existing = {
      id: 'conversation-live',
      title: 'Live',
      archived: false,
      createdAt: '2026-07-12T00:00:00Z',
      updatedAt: '2026-07-12T00:00:01Z',
      messages: [{
        id: 'assistant-live-client',
        role: 'assistant' as const,
        content: 'newer live text',
        createdAt: '2026-07-12T00:00:00Z',
        status: 'streaming' as const,
        runId: 'run-live',
        lastEventSeq: 8,
      }],
    }

    const conversation = projectRuntimeThread(snapshot, existing)

    expect(conversation.messages[0]?.lastEventSeq).toBe(8)
  })
})
