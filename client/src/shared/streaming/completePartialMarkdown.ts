/**
 * Make a partially-streamed Markdown string safe to parse *now*, so the
 * renderer shows formatting immediately instead of flashing raw markers
 * (`**你好`) and snapping to bold only once the closing token arrives.
 *
 * Strictly **append-only** and **idempotent**: the output always starts with
 * the input, and already-complete Markdown is returned unchanged. This is
 * essential — re-running it every animation frame on the growing text must
 * never rewrite earlier content (that would cause flicker).
 *
 * Scope mirrors the industry approach (ChatGPT/Claude, Vercel Streamdown's
 * `parseIncompleteMarkdown`): fenced code blocks, inline code, `**`, `*`,
 * `~~`, and an unterminated link target. Underscore emphasis is intentionally
 * left alone — `_` appears too often in identifiers/filenames to balance
 * safely, and models overwhelmingly emit `**`.
 */
export function completePartialMarkdown(text: string): string {
  if (!text) {
    return text
  }

  // 1) Fenced code block (``` or ~~~). An odd number of fence delimiters at
  //    line starts means we're inside an open block — close it and stop;
  //    its body is literal, so no inline balancing applies.
  const fences = text.match(/^[ \t]*(`{3,}|~{3,})/gm) ?? []
  if (fences.length % 2 === 1) {
    return `${text}${text.endsWith('\n') ? '' : '\n'}\`\`\``
  }

  // Blank out complete fenced blocks and complete inline-code spans so their
  // contents don't get counted as emphasis. Replace with equal-length spaces
  // to keep indices aligned for ordering.
  const blanks = (match: string) => ' '.repeat(match.length)
  const withoutFenced = text.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, blanks)
  const scan = withoutFenced.replace(/`[^`\n]*`/g, blanks)

  // 2) Unterminated inline code — close it and stop (body is literal).
  if (((scan.match(/`/g) ?? []).length) % 2 === 1) {
    return `${text}\``
  }

  // 3) Unbalanced emphasis / strikethrough.
  const closers: Array<{ marker: string; at: number }> = []
  for (const marker of ['~~', '**']) {
    if (occurrences(scan, marker) % 2 === 1) {
      closers.push({ marker, at: scan.lastIndexOf(marker) })
    }
  }
  const singleStars = scan.replace(/\*\*/g, '  ')
  if (((singleStars.match(/\*/g) ?? []).length) % 2 === 1) {
    closers.push({ marker: '*', at: singleStars.lastIndexOf('*') })
  }
  // Close the most-recently-opened marker first (best-effort nesting).
  closers.sort((a, b) => b.at - a.at)
  let suffix = closers.map((entry) => entry.marker).join('')

  // 4) Unterminated link / image target: `](partial` with no closing `)`.
  if (/\]\([^)\s]*$/.test(text)) {
    suffix += ')'
  }

  return suffix ? text + suffix : text
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}
