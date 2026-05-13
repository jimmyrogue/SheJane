import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSmartAutoScroll } from './useSmartAutoScroll'

function defineScrollMetrics(element: HTMLElement, metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  Object.defineProperty(element, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
  Object.defineProperty(element, 'scrollTop', { value: metrics.scrollTop, configurable: true, writable: true })
  Object.defineProperty(element, 'clientHeight', { value: metrics.clientHeight, configurable: true })
}

function Harness({ tick }: { tick: number }) {
  const ref = useSmartAutoScroll<HTMLDivElement>([tick], { bottomThreshold: 80 })
  return <div data-testid="scroll" ref={ref} />
}

describe('useSmartAutoScroll', () => {
  it('sticks to bottom only while the user stays near the bottom', () => {
    const { getByTestId, rerender } = render(<Harness tick={1} />)
    const element = getByTestId('scroll')
    const scrollTo = vi.fn()
    Object.defineProperty(element, 'scrollTo', { value: scrollTo, configurable: true })

    defineScrollMetrics(element, { scrollHeight: 1000, scrollTop: 930, clientHeight: 80 })
    fireEvent.scroll(element)
    rerender(<Harness tick={2} />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })

    scrollTo.mockClear()
    defineScrollMetrics(element, { scrollHeight: 1200, scrollTop: 200, clientHeight: 80 })
    fireEvent.scroll(element)
    rerender(<Harness tick={3} />)
    expect(scrollTo).not.toHaveBeenCalled()

    defineScrollMetrics(element, { scrollHeight: 1200, scrollTop: 1130, clientHeight: 80 })
    fireEvent.scroll(element)
    act(() => {
      rerender(<Harness tick={4} />)
    })
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' })
  })
})
