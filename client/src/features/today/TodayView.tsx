import { useEffect, useMemo, useState } from 'react'
import { IconArrowUp, IconCheck, IconMessage } from '@tabler/icons-react'
import {
  listLocalTodos,
  quoteLocalTodoItem,
  updateLocalTodoItem,
  type LocalHostConfig,
  type QuoteLocalTodoRequest,
  type QuoteLocalTodoResponse,
  type LocalTodoItem,
  type UpdateLocalTodoItemRequest,
} from '@/shared/local-host/client'

type Priority = 'now' | 'today' | 'later' | 'fyi'

interface TodoItem {
  id: string
  localID?: string
  lv: Priority
  from: string
  text: string
  dueAt?: string | null
  done: boolean
}

interface TodayViewApi {
  listTodos: (config: LocalHostConfig) => Promise<LocalTodoItem[]>
  updateTodo: (todoID: string, input: UpdateLocalTodoItemRequest, config: LocalHostConfig) => Promise<LocalTodoItem>
  quoteTodo: (todoID: string, input: QuoteLocalTodoRequest, config: LocalHostConfig) => Promise<QuoteLocalTodoResponse>
}

interface TodayViewProps {
  onQuoteToChat?: (text: string) => void
  localHostConfig?: LocalHostConfig | null
  api?: Partial<TodayViewApi>
}

const MOCK_TODOS: TodoItem[] = [
  { id: 't1', lv: 'now', from: '李总 · 私聊', text: 'Q3 预算的数字今天上午要，先给个初版也行', done: false },
  { id: 't2', lv: 'now', from: '中台迁移群', text: '下游报表接口适配卡住了，问你灰度计划是否要推迟', done: false },
  { id: 't3', lv: 'today', from: '产品评审群', text: '定价页 A/B 文案投票，今天 18:00 截止', done: true },
  { id: 't4', lv: 'today', from: 'HR 小张', text: '团队 6 月考勤异常 2 条，需要你确认', done: false },
  { id: 't5', lv: 'later', from: '行政通知', text: '下周三办公区消防演习，全员参加', done: false },
  { id: 't6', lv: 'fyi', from: '公司全员群', text: '新版报销系统 6/20 上线，旧入口保留至月底', done: false },
]

const LV_META: Record<Priority, { name: string; cls: string }> = {
  now: { name: '现在回', cls: 'today-dot-now' },
  today: { name: '今天内', cls: 'today-dot-today' },
  later: { name: '稍后处理', cls: 'today-dot-later' },
  fyi: { name: '只需知道', cls: 'today-dot-fyi' },
}

const ORDER: Priority[] = ['now', 'today', 'later', 'fyi']
const DEFAULT_API: TodayViewApi = {
  listTodos: listLocalTodos,
  updateTodo: updateLocalTodoItem,
  quoteTodo: quoteLocalTodoItem,
}
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function todayLabel(now: Date): string {
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${WEEKDAYS[now.getDay()]}`
}

function mapLocalTodo(todo: LocalTodoItem): TodoItem {
  return {
    id: todo.id,
    localID: todo.id,
    lv: todo.priority,
    from: todo.summary || '飞书 Lark',
    text: todo.title || todo.evidence_preview,
    dueAt: todo.due_at,
    done: todo.status === 'completed' || todo.status === 'dismissed' || todo.status === 'snoozed',
  }
}

function formatTodoDueAt(value?: string | null): string {
  const text = (value || '').trim()
  if (!text) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
  if (!match) return text
  return `${Number(match[2])} 月 ${Number(match[3])} 日 ${match[4]}:${match[5]}`
}

export function TodayView({ onQuoteToChat, localHostConfig, api }: TodayViewProps = {}) {
  const localManaged = localHostConfig !== undefined
  const localApi = useMemo(() => ({ ...DEFAULT_API, ...api }), [api])
  const [todos, setTodos] = useState<TodoItem[]>(() => (localManaged ? [] : MOCK_TODOS))
  const [draft, setDraft] = useState('')
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'unavailable'>(
    localManaged ? 'loading' : 'idle',
  )
  const [loadMessage, setLoadMessage] = useState('')
  const dateLabel = useMemo(() => todayLabel(new Date()), [])

  useEffect(() => {
    if (!localManaged) {
      setTodos(MOCK_TODOS)
      setLoadState('idle')
      setLoadMessage('')
      return
    }
    if (!localHostConfig) {
      setTodos([])
      setLoadState('unavailable')
      setLoadMessage('本地服务未连接')
      return
    }
    let canceled = false
    setLoadState('loading')
    setLoadMessage('')
    localApi.listTodos(localHostConfig)
      .then((next) => {
        if (!canceled) {
          setTodos(next.map(mapLocalTodo))
          setLoadState('ready')
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setTodos([])
          setLoadState('error')
          setLoadMessage(error instanceof Error ? error.message : '读取本地待办失败')
        }
      })
    return () => {
      canceled = true
    }
  }, [localApi, localHostConfig, localManaged])

  const persistTodoUpdate = (
    item: TodoItem,
    input: UpdateLocalTodoItemRequest,
    optimistic: (todo: TodoItem) => TodoItem,
  ) => {
    const previous = todos
    setTodos((ts) => ts.map((x) => (x.id === item.id ? optimistic(x) : x)))
    if (!localHostConfig || !item.localID) return
    localApi.updateTodo(item.localID, input, localHostConfig)
      .then((updated) => {
        setTodos((ts) => ts.map((x) => (x.id === item.id ? mapLocalTodo(updated) : x)))
      })
      .catch((error: unknown) => {
        setTodos(previous)
        setLoadState('error')
        setLoadMessage(error instanceof Error ? error.message : '更新本地待办失败')
      })
  }

  const toggle = (id: string) => {
    const current = todos.find((todo) => todo.id === id)
    if (!current) return
    const nextDone = !current.done
    persistTodoUpdate(
      current,
      { status: nextDone ? 'completed' : 'open' },
      (todo) => ({ ...todo, done: nextDone }),
    )
  }

  const dismiss = (item: TodoItem) => {
    persistTodoUpdate(item, { status: 'dismissed' }, (todo) => ({ ...todo, done: true }))
  }

  const quote = (item: TodoItem) => {
    if (!localHostConfig || !item.localID) {
      onQuoteToChat?.(item.text)
      return
    }
    localApi.quoteTodo(item.localID, {}, localHostConfig)
      .then((response) => {
        onQuoteToChat?.(response.text)
      })
      .catch((error: unknown) => {
        setLoadState('error')
        setLoadMessage(error instanceof Error ? error.message : '引用本地待办失败')
      })
  }

  const left = todos.filter((t) => !t.done).length
  const nowLeft = todos.filter((t) => !t.done && t.lv === 'now').length
  const leadPrefix = localManaged ? `本机飞书归拢成 ${todos.length} 件事——` : '47 条消息、3 场会议，归拢成 6 件事——'

  return (
    <section className="workspace">
      <div className="skills-scroll">
        <div className="today-content">
          <header className="today-head">
            <span className="today-title">今日</span>
            <span className="today-date">{dateLabel}</span>
            <span className="today-source">9:00 整理 · 来源 飞书 / 日历</span>
          </header>
          <p className="today-lead">
            {leadPrefix}
            {nowLeft > 0 ? `要紧的还剩 ${nowLeft} 件。` : '要紧的都处理完了。'}
          </p>

          {loadState === 'loading' ? <p className="today-empty">正在读取本机待办…</p> : null}
          {loadState === 'unavailable' || loadState === 'error' ? <p className="today-empty">{loadMessage}</p> : null}
          {localManaged && loadState === 'ready' && todos.length === 0 ? <p className="today-empty">暂时没有从飞书归拢出的待办。</p> : null}

          {ORDER.map((lv) => {
            const items = todos.filter((t) => t.lv === lv)
            if (!items.length) return null
            return (
              <div className="today-group" key={lv}>
                <div className="today-group-head">
                  <span className={`today-dot ${LV_META[lv].cls}`} aria-hidden="true" />
                  <span className="today-group-name">{LV_META[lv].name}</span>
                  <span className="today-group-count">{items.length} 件</span>
                </div>
                {items.map((item) => (
                  <div className={`today-row${item.done ? ' is-done' : ''}`} key={item.id}>
                    <button
                      type="button"
                      className={`today-check${item.done ? ' is-done' : ''}`}
                      aria-label={item.done ? '标记为未完成' : '标记为完成'}
                      aria-pressed={item.done}
                      onClick={() => toggle(item.id)}
                    >
                      {item.done ? <IconCheck size={11} stroke={2.4} aria-hidden="true" /> : null}
                    </button>
                    <div className="today-row-main">
                      <div className="today-row-text">{item.text}</div>
                      <div className="today-row-meta">
                        <span>{item.from}</span>
                        {item.dueAt ? <span>截止 {formatTodoDueAt(item.dueAt)}</span> : null}
                      </div>
                    </div>
                    {!item.done ? (
                      <button
                        type="button"
                        className="today-row-quote"
                        onClick={() => quote(item)}
                      >
                        <IconMessage size={12} aria-hidden="true" /> 引用到对话
                      </button>
                    ) : null}
                    {!item.done ? (
                      <div className="today-row-controls">
                        <button type="button" className="today-row-mini" onClick={() => dismiss(item)}>
                          忽略
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          })}

          <p className="today-footnote">
            {left === 0 ? '今日事毕 · 石间替你守着新消息' : '完成的事会沉下去，不打扰'}
          </p>
        </div>
      </div>

      <div className="today-dock">
        <div className="today-composer">
          <textarea
            className="today-composer-input"
            rows={1}
            value={draft}
            placeholder="直接和石间商量安排"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="today-composer-send"
            aria-label="发送"
            disabled={!draft.trim()}
            onClick={() => setDraft('')}
          >
            <IconArrowUp size={15} aria-hidden="true" />
          </button>
        </div>
        <p className="today-composer-hint">直接和石间商量——「把考勤的事挪到明天」「这条不重要」</p>
      </div>
    </section>
  )
}
