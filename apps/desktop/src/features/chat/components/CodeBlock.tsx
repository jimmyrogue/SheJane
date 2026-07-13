import { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { useI18n } from '@/shared/i18n/i18n'

// Curated language set — registering only these keeps the bundle small and
// highlightAuto fast. Each grammar self-registers its aliases (js→javascript,
// ts→typescript, py→python, sh→bash, html→xml, etc.).
let registered = false
function ensureLanguages() {
  if (registered) {
    return
  }
  registered = true
  hljs.registerLanguage('bash', bash)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('go', go)
  hljs.registerLanguage('java', java)
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('markdown', markdown)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('rust', rust)
  hljs.registerLanguage('sql', sql)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('yaml', yaml)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One fenced code block: a header bar (language label + per-block copy
 *  button) over a highlighted <pre>. The copy button copies the RAW code
 *  (not the whole message) and has its own accessible name so it never
 *  collides with the message-level copy button. */
export function CodeBlock({ language, code }: { language?: string; code: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetRef.current), [])

  const { html, resolvedLang } = useMemo(() => {
    ensureLanguages()
    const requested = language && hljs.getLanguage(language) ? language : ''
    try {
      if (requested) {
        return { html: hljs.highlight(code, { language: requested }).value, resolvedLang: requested }
      }
      const auto = hljs.highlightAuto(code)
      return { html: auto.value, resolvedLang: auto.language ?? '' }
    } catch {
      return { html: escapeHtml(code), resolvedLang: '' }
    }
  }, [code, language])

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      window.clearTimeout(resetRef.current)
      resetRef.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || resolvedLang || 'text'}</span>
        <button
          type="button"
          className="code-block-copy"
          onClick={handleCopy}
          title={copied ? t('code.copied') : t('code.copy')}
          aria-label={copied ? t('code.copied') : t('code.copy')}
        >
          {copied ? <IconCheck size={13} aria-hidden="true" /> : <IconCopy size={13} aria-hidden="true" />}
        </button>
      </div>
      <pre className="code-block-pre">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
