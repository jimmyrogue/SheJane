import { describe, expect, it } from 'vitest'
import { completePartialMarkdown } from './completePartialMarkdown'

describe('completePartialMarkdown', () => {
  it('leaves complete or plain text unchanged (idempotent)', () => {
    for (const input of [
      '',
      '你好，今天天气不错。',
      '**已闭合**的粗体和 `code` 与 [链接](https://example.com)',
      '```\ncode block closed\n```',
      '~~done~~',
    ]) {
      expect(completePartialMarkdown(input)).toBe(input)
      expect(completePartialMarkdown(completePartialMarkdown(input))).toBe(input)
    }
  })

  it('closes an unbalanced bold marker', () => {
    expect(completePartialMarkdown('**你好')).toBe('**你好**')
    expect(completePartialMarkdown('正文 **加粗中')).toBe('正文 **加粗中**')
  })

  it('closes single-star italic and strikethrough', () => {
    expect(completePartialMarkdown('*斜体')).toBe('*斜体*')
    expect(completePartialMarkdown('~~删除')).toBe('~~删除~~')
  })

  it('closes an open fenced code block (and ignores inline inside it)', () => {
    expect(completePartialMarkdown('```ts\nconst a = **1')).toBe('```ts\nconst a = **1\n```')
  })

  it('closes unterminated inline code without touching emphasis', () => {
    expect(completePartialMarkdown('运行 `npm run **build')).toBe('运行 `npm run **build`')
  })

  it('closes an unterminated link target', () => {
    expect(completePartialMarkdown('见 [文档](https://ex')).toBe('见 [文档](https://ex)')
  })

  it('does not count markers inside completed code', () => {
    expect(completePartialMarkdown('`a*b` 普通文本')).toBe('`a*b` 普通文本')
  })

  it('is always append-only', () => {
    for (const input of ['**a', '`x', '*y', '~~z', '```\nq', '[t](u']) {
      expect(completePartialMarkdown(input).startsWith(input)).toBe(true)
    }
  })
})
