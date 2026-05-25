import { describe, expect, it } from 'vitest'
import {
  functionToken,
  mcpToken,
  parseSkillDraft,
  skillToken,
  SKILL_OPEN,
  SKILL_CLOSE,
  tokenizeDraft,
} from './skillDraft'

const hunt = skillToken('hunt')
const write = skillToken('write')
const imageFn = functionToken('image')
const githubMcp = mcpToken('github')
const playwrightMcp = mcpToken('playwright')

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
      functions: [],
      mcps: [],
    })
  })

  it('returns plain text unchanged with no skills', () => {
    expect(parseSkillDraft('no skills here')).toEqual({
      text: 'no skills here',
      skills: [],
      functions: [],
      mcps: [],
    })
  })

  it('round-trips: skillToken is exactly OPEN+name+CLOSE', () => {
    expect(skillToken('demo')).toBe(`${SKILL_OPEN}demo${SKILL_CLOSE}`)
    expect(parseSkillDraft(skillToken('demo'))).toEqual({
      text: '@demo',
      skills: ['demo'],
      functions: [],
      mcps: [],
    })
  })

  it('collects function tokens separately and adds no literal text', () => {
    expect(tokenizeDraft(`${imageFn}一只猫`)).toEqual([
      { type: 'function', name: 'image' },
      { type: 'text', value: '一只猫' },
    ])
    expect(parseSkillDraft(`${imageFn}画一只在月球上的猫`)).toEqual({
      text: '画一只在月球上的猫',
      skills: [],
      functions: ['image'],
      mcps: [],
    })
  })

  it('handles skills and functions together, de-duplicated', () => {
    expect(parseSkillDraft(`${imageFn}${hunt} 用 ${imageFn} 再来 ${write}`)).toEqual({
      text: '@hunt 用  再来 @write',
      skills: ['hunt', 'write'],
      functions: ['image'],
      mcps: [],
    })
  })

  it('tokenizes MCP server references as their own node type', () => {
    expect(tokenizeDraft(`查一下 ${githubMcp} 仓库`)).toEqual([
      { type: 'text', value: '查一下 ' },
      { type: 'mcp', name: 'github' },
      { type: 'text', value: ' 仓库' },
    ])
  })

  it('renders MCP tokens as @mcp:name and dedupes them', () => {
    const draft = `${githubMcp} 列 PR，然后 ${githubMcp} 拉 issue，再用 ${playwrightMcp} 跑用例`
    expect(parseSkillDraft(draft)).toEqual({
      text: '@mcp:github 列 PR，然后 @mcp:github 拉 issue，再用 @mcp:playwright 跑用例',
      skills: [],
      functions: [],
      mcps: ['github', 'playwright'],
    })
  })

  it('mixes skill + function + MCP tokens in a single draft', () => {
    expect(parseSkillDraft(`${imageFn}${hunt} ${githubMcp} 帮我做这件事`)).toEqual({
      text: '@hunt @mcp:github 帮我做这件事',
      skills: ['hunt'],
      functions: ['image'],
      mcps: ['github'],
    })
  })
})
