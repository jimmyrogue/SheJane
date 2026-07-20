import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Switch } from './switch'

afterEach(cleanup)

describe('Switch', () => {
  it('uses the v4 compact track geometry', () => {
    render(<Switch checked aria-label="测试开关" />)

    const root = screen.getByRole('switch', { name: '测试开关' })
    const thumb = root.querySelector('[data-slot="switch-thumb"]')
    expect(root.className).toContain('w-[34px]')
    expect(root.className).toContain('h-[20px]')
    expect(root.className).toContain('border-0')
    expect(root.className).toContain('p-0')
    expect(root.className).not.toContain('w-9')
    expect(thumb?.className).toContain('h-[16px]')
    expect(thumb?.className).toContain('w-[16px]')
    expect(thumb?.className).toContain('data-[state=checked]:translate-x-[16px]')
    expect(thumb?.className).toContain('data-[state=unchecked]:translate-x-[2px]')
  })
})
