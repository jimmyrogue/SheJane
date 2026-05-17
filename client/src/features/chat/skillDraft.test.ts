import { describe, expect, it } from 'vitest'
import { parseSkillDraft, skillToken, SKILL_OPEN, SKILL_CLOSE, tokenizeDraft } from './skillDraft'

const hunt = skillToken('hunt')
const write = skillToken('write')

describe('skillDraft.tokenizeDraft', () => {
  it('returns nothing for an empty draft', () => {
    expect(tokenizeDraft('')).toEqual([])
  })

  it('returns a single text node for plain text', () => {
    expect(tokenizeDraft('just text')).toEqual([{ type: 'text', value: 'just text' }])
  })

  it('splits a token in the middle', () => {
    expect(tokenizeDraft(`fix ${hunt} now`)).toEqual([
      { type: 'text', value: 'fix ' },
      { type: 'skill', name: 'hunt' },
      { type: 'text', value: ' now' },
    ])
  })

  it('handles a leading and trailing token and adjacent tokens', () => {
    expect(tokenizeDraft(`${hunt}${write} tail`)).toEqual([
      { type: 'skill', name: 'hunt' },
      { type: 'skill', name: 'write' },
      { type: 'text', value: ' tail' },
    ])
    expect(tokenizeDraft(`${hunt}`)).toEqual([{ type: 'skill', name: 'hunt' }])
  })

  it('keeps newlines in text nodes', () => {
    expect(tokenizeDraft(`a\n${hunt}\nb`)).toEqual([
      { type: 'text', value: 'a\n' },
      { type: 'skill', name: 'hunt' },
      { type: 'text', value: '\nb' },
    ])
  })

  it('treats an unmatched open sentinel as plain text', () => {
    const broken = `oops ${SKILL_OPEN}hunt no close`
    expect(tokenizeDraft(broken)).toEqual([{ type: 'text', value: broken }])
  })

  it('does not collide with normal or Chinese text', () => {
    const draft = '用 / 斜杠 和 @ 符号，正常中文不应被当作 token'
    expect(tokenizeDraft(draft)).toEqual([{ type: 'text', value: draft }])
  })
})

describe('skillDraft.parseSkillDraft', () => {
  it('renders tokens as @name and collects skills in first-seen order, de-duplicated', () => {
    const draft = `先 ${hunt} 看，再 ${write} 改，最后再 ${hunt} 复查`
    expect(parseSkillDraft(draft)).toEqual({
      text: '先 @hunt 看，再 @write 改，最后再 @hunt 复查',
      skills: ['hunt', 'write'],
    })
  })

  it('returns plain text unchanged with no skills', () => {
    expect(parseSkillDraft('no skills here')).toEqual({ text: 'no skills here', skills: [] })
  })

  it('round-trips: skillToken is exactly OPEN+name+CLOSE', () => {
    expect(skillToken('demo')).toBe(`${SKILL_OPEN}demo${SKILL_CLOSE}`)
    expect(parseSkillDraft(skillToken('demo'))).toEqual({ text: '@demo', skills: ['demo'] })
  })
})
