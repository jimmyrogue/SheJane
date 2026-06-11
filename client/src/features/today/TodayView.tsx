import { useMemo, useState } from 'react'
import { IconArrowUp, IconCheck, IconMessage } from '@tabler/icons-react'

/**
 * 「今日 · 待办」 view — a faithful front-end port of the v4 prototype's
 * SjpTodayView (priority-grouped, checkable, with a natural-language adjust
 * box).
 *
 * IMPORTANT: this ships with MOCK data. Per CLAUDE.md the product does not yet
 * have a todo/IM-digest backend, so there is no real data source to bind. This
 * surface is a working prototype to be wired to real data once the model
 * exists; until then it demonstrates the interaction + visual language only.
 */

type Priority = 'now' | 'today' | 'later' | 'fyi'

interface TodoItem {
  id: string
  lv: Priority
  from: string
  text: string
  action: string | null
  done: boolean
}

const MOCK_TODOS: TodoItem[] = [
  { id: 't1', lv: 'now', from: '李总 · 私聊', text: 'Q3 预算的数字今天上午要，先给个初版也行', action: '回复草稿', done: false },
  { id: 't2', lv: 'now', from: '中台迁移群', text: '下游报表接口适配卡住了，问你灰度计划是否要推迟', action: '回复草稿', done: false },
  { id: 't3', lv: 'today', from: '产品评审群', text: '定价页 A/B 文案投票，今天 18:00 截止', action: '转任务', done: true },
  { id: 't4', lv: 'today', from: 'HR 小张', text: '团队 6 月考勤异常 2 条，需要你确认', action: '转任务', done: false },
  { id: 't5', lv: 'later', from: '行政通知', text: '下周三办公区消防演习，全员参加', action: '记到日历', done: false },
  { id: 't6', lv: 'fyi', from: '公司全员群', text: '新版报销系统 6/20 上线，旧入口保留至月底', action: null, done: false },
]

const LV_META: Record<Priority, { name: string; cls: string }> = {
  now: { name: '现在回', cls: 'today-dot-now' },
  today: { name: '今天内', cls: 'today-dot-today' },
  later: { name: '可放一放', cls: 'today-dot-later' },
  fyi: { name: '只需知道', cls: 'today-dot-fyi' },
}

const ORDER: Priority[] = ['now', 'today', 'later', 'fyi']

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function todayLabel(now: Date): string {
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${WEEKDAYS[now.getDay()]}`
}

export function TodayView({ onQuoteToChat }: { onQuoteToChat?: (text: string) => void }) {
  const [todos, setTodos] = useState<TodoItem[]>(MOCK_TODOS)
  const [draft, setDraft] = useState('')
  const dateLabel = useMemo(() => todayLabel(new Date()), [])

  const toggle = (id: string) => setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))
  const left = todos.filter((t) => !t.done).length
  const nowLeft = todos.filter((t) => !t.done && t.lv === 'now').length

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
            47 条消息、3 场会议，归拢成 6 件事——
            {nowLeft > 0 ? `要紧的还剩 ${nowLeft} 件。` : '要紧的都处理完了。'}
          </p>

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
                        <span>·</span>
                        <button type="button" className="today-row-source">看原文</button>
                      </div>
                    </div>
                    {!item.done ? (
                      <button
                        type="button"
                        className="today-row-quote"
                        onClick={() => onQuoteToChat?.(item.text)}
                      >
                        <IconMessage size={12} aria-hidden="true" /> 引用到对话
                      </button>
                    ) : null}
                    {!item.done && item.action ? <span className="today-row-action">{item.action}</span> : null}
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
