import { useEffect, useRef } from 'react'

export interface SmartAutoScrollOptions {
  bottomThreshold?: number
  behavior?: ScrollBehavior
}

export function useSmartAutoScroll<T extends HTMLElement>(
  deps: unknown[],
  options: SmartAutoScrollOptions = {},
) {
  const bottomThreshold = options.bottomThreshold ?? 96
  const behavior = options.behavior ?? 'smooth'
  const containerRef = useRef<T | null>(null)
  const shouldStickToBottomRef = useRef(true)

  useEffect(() => {
    const element = containerRef.current
    if (!element) {
      return
    }
    const handleScroll = () => {
      const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
      shouldStickToBottomRef.current = distanceToBottom <= bottomThreshold
    }
    element.addEventListener('scroll', handleScroll, { passive: true })
    return () => element.removeEventListener('scroll', handleScroll)
  }, [bottomThreshold])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !shouldStickToBottomRef.current) {
      return
    }
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({
        top: element.scrollHeight,
        behavior,
      })
    } else {
      element.scrollTop = element.scrollHeight
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return containerRef
}
