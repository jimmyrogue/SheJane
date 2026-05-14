import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface StreamSegment {
  id: number
  text: string
}

export interface SmoothTextStreamOptions {
  locale?: 'zh' | 'en' | 'auto'
  segmentsPerTick?: number
  tickMs?: number
  onCommit?: (text: string) => void
}

export interface SmoothTextStreamState {
  segments: StreamSegment[]
  text: string
  isStreaming: boolean
  start: (initialText?: string) => void
  pushChunk: (chunk: string) => void
  finish: () => void
  cancel: () => void
}

export function segmentStreamText(text: string, locale: SmoothTextStreamOptions['locale'] = 'auto'): string[] {
  if (!text) {
    return []
  }
  const resolvedLocale = locale === 'auto' ? (containsCJK(text) ? 'zh' : 'en') : locale
  if (resolvedLocale === 'zh' && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    return Array.from(segmenter.segment(text), (part) => part.segment).filter(Boolean)
  }
  return text.match(/\S+\s*|\s+/g) ?? []
}

export function useSmoothTextStream(options: SmoothTextStreamOptions = {}): SmoothTextStreamState {
  const locale = options.locale ?? 'auto'
  const segmentsPerTick = options.segmentsPerTick ?? 2
  const tickMs = options.tickMs ?? 24
  const onCommitRef = useRef(options.onCommit)
  const [segments, setSegments] = useState<StreamSegment[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const bufferRef = useRef('')
  const queueRef = useRef<string[]>([])
  const timerRef = useRef<number | undefined>()
  const idRef = useRef(0)

  useEffect(() => {
    onCommitRef.current = options.onCommit
  }, [options.onCommit])

  const appendSegments = useCallback((items: string[]) => {
    if (!items.length) {
      return
    }
    const next = items.map((text) => ({ id: idRef.current++, text }))
    setSegments((previous) => [...previous, ...next])
    onCommitRef.current?.(items.join(''))
  }, [])

  const drainBufferToQueue = useCallback((flushAll: boolean) => {
    const raw = bufferRef.current
    if (!raw) {
      return
    }
    const parts = segmentStreamText(raw, locale)
    if (!parts.length) {
      return
    }
    if (flushAll) {
      queueRef.current.push(...parts)
      bufferRef.current = ''
      return
    }
    const last = parts.at(-1) ?? ''
    const lastLooksComplete = /[\s。！？.!?，,；;：:、）)\]}》」』”"']$/.test(last)
    if (lastLooksComplete || parts.length > 1) {
      const ready = lastLooksComplete ? parts : parts.slice(0, -1)
      queueRef.current.push(...ready)
      bufferRef.current = lastLooksComplete ? '' : last
    }
  }, [locale])

  const tick = useCallback(() => {
    drainBufferToQueue(false)
    const next = queueRef.current.splice(0, segmentsPerTick)
    appendSegments(next)
    timerRef.current = window.setTimeout(tick, tickMs)
  }, [appendSegments, drainBufferToQueue, segmentsPerTick, tickMs])

  const stopTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const start = useCallback((initialText = '') => {
    stopTimer()
    bufferRef.current = ''
    queueRef.current = []
    idRef.current = initialText ? 1 : 0
    setSegments(initialText ? [{ id: 0, text: initialText }] : [])
    setIsStreaming(true)
    timerRef.current = window.setTimeout(tick, tickMs)
  }, [stopTimer, tick, tickMs])

  const pushChunk = useCallback((chunk: string) => {
    if (!chunk) {
      return
    }
    bufferRef.current += chunk
  }, [])

  const finish = useCallback(() => {
    drainBufferToQueue(true)
    appendSegments(queueRef.current.splice(0))
    setIsStreaming(false)
    stopTimer()
  }, [appendSegments, drainBufferToQueue, stopTimer])

  const cancel = useCallback(() => {
    bufferRef.current = ''
    queueRef.current = []
    setSegments([])
    setIsStreaming(false)
    stopTimer()
  }, [stopTimer])

  useEffect(() => stopTimer, [stopTimer])

  const text = useMemo(() => segments.map((segment) => segment.text).join(''), [segments])

  return {
    segments,
    text,
    isStreaming,
    start,
    pushChunk,
    finish,
    cancel,
  }
}

function containsCJK(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}
