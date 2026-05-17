// The chat draft is a single string (App's source of truth). Inline skill
// mentions are embedded with collision-proof Unicode Private Use Area
// sentinels so normal text / Chinese input can never produce them. These pure
// helpers convert between the raw draft string and a structured view, and are
// the deterministic correctness core for both the editor and the send path.

export const SKILL_OPEN = ''
export const SKILL_CLOSE = ''

// Token = OPEN, then a name with no sentinel chars, then CLOSE.
const skillTokenPattern = (): RegExp =>
  new RegExp(`${SKILL_OPEN}([^${SKILL_OPEN}${SKILL_CLOSE}]+)${SKILL_CLOSE}`, 'g')

export type DraftNode = { type: 'text'; value: string } | { type: 'skill'; name: string }

/** Wrap a skill name into its sentinel token form. */
export function skillToken(name: string): string {
  return `${SKILL_OPEN}${name}${SKILL_CLOSE}`
}

/**
 * Split a raw draft into ordered text / skill nodes. Malformed sentinels
 * (an open without a matching close, or an empty name) are treated as plain
 * text so nothing is ever lost.
 */
export function tokenizeDraft(draft: string): DraftNode[] {
  const nodes: DraftNode[] = []
  const pattern = skillTokenPattern()
  let lastIndex = 0
  for (let match = pattern.exec(draft); match; match = pattern.exec(draft)) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: draft.slice(lastIndex, match.index) })
    }
    nodes.push({ type: 'skill', name: match[1] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < draft.length) {
    nodes.push({ type: 'text', value: draft.slice(lastIndex) })
  }
  return nodes
}

/**
 * Resolve a raw draft into what the user/agent should actually see:
 * - `text`: human-readable string with each token rendered as `@name`
 *   (used for the chat bubble and the task text sent to the agent).
 * - `skills`: skill names in first-seen order, de-duplicated (used to force
 *   per-run skills + the skill.use directive prefix).
 */
export function parseSkillDraft(draft: string): { text: string; skills: string[] } {
  const skills: string[] = []
  let text = ''
  for (const node of tokenizeDraft(draft)) {
    if (node.type === 'text') {
      text += node.value
    } else {
      text += `@${node.name}`
      if (!skills.includes(node.name)) {
        skills.push(node.name)
      }
    }
  }
  return { text, skills }
}
