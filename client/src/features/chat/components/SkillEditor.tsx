import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  type TextNode,
} from 'lexical'
import { $createSkillNode, $isSkillNode, SkillNode } from './SkillNode'
import { tokenizeDraft } from '../skillDraft'
import { useI18n } from '@/shared/i18n/i18n'
import type { InstalledSkill } from '@/shared/local-host/client'

export interface SkillEditorProps {
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  listSkills: () => Promise<InstalledSkill[]>
  placeholder: string
}

class SkillMenuOption extends MenuOption {
  name: string
  description: string
  constructor(skill: InstalledSkill) {
    super(`${skill.name}|${skill.path}`)
    this.name = skill.name
    this.description = skill.description
  }
}

function buildRootFromDraft(draft: string): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  for (const node of tokenizeDraft(draft)) {
    if (node.type === 'skill') {
      paragraph.append($createSkillNode(node.name))
      continue
    }
    const parts = node.value.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) {
        paragraph.append($createLineBreakNode())
      }
      if (part) {
        paragraph.append($createTextNode(part))
      }
    })
  }
  root.append(paragraph)
  root.selectEnd()
}

function ExternalDraftPlugin({
  draft,
  lastSerializedRef,
}: {
  draft: string
  lastSerializedRef: { current: string }
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (draft === lastSerializedRef.current) {
      return
    }
    lastSerializedRef.current = draft
    editor.update(() => buildRootFromDraft(draft))
  }, [draft, editor, lastSerializedRef])
  return null
}

function SubmitPlugin({
  onSend,
  menuOpenRef,
}: {
  onSend: () => void
  menuOpenRef: { current: boolean }
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (menuOpenRef.current) {
            return false
          }
          if (event && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSend()
            return true
          }
          if (event) {
            event.preventDefault()
          }
          editor.update(() => {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) {
              selection.insertLineBreak()
            }
          })
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, onSend, menuOpenRef],
  )
  return null
}

function SkillDeletePlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const handle = (isBackward: boolean): boolean => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return false
      }
      const anchor = selection.anchor
      const node = anchor.getNode()
      let target = null
      if (anchor.type === 'text') {
        if (isBackward && anchor.offset === 0) {
          target = node.getPreviousSibling()
        } else if (!isBackward && anchor.offset === node.getTextContentSize()) {
          target = node.getNextSibling()
        }
      } else {
        const index = isBackward ? anchor.offset - 1 : anchor.offset
        target = 'getChildAtIndex' in node ? node.getChildAtIndex(index) : null
      }
      if (target && $isSkillNode(target)) {
        target.remove()
        return true
      }
      return false
    }
    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      () => handle(true),
      COMMAND_PRIORITY_LOW,
    )
    const unregisterDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      () => handle(false),
      COMMAND_PRIORITY_LOW,
    )
    return () => {
      unregisterBackspace()
      unregisterDelete()
    }
  }, [editor])
  return null
}

function SkillTypeaheadPlugin({
  listSkills,
  menuOpenRef,
}: {
  listSkills: () => Promise<InstalledSkill[]>
  menuOpenRef: { current: boolean }
}) {
  const [editor] = useLexicalComposerContext()
  const { t } = useI18n()
  const [query, setQuery] = useState<string | null>(null)
  const [skills, setSkills] = useState<InstalledSkill[]>([])
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (query !== null && !loadedRef.current) {
      loadedRef.current = true
      setLoading(true)
      listSkills()
        .then(setSkills)
        .catch(() => setSkills([]))
        .finally(() => setLoading(false))
    }
    if (query === null) {
      loadedRef.current = false
    }
  }, [query, listSkills])

  const triggerFn = useCallback((text: string): MenuTextMatch | null => {
    const match = /(^|\s)\/([^\s/]*)$/.exec(text)
    if (match === null) {
      return null
    }
    const matchingString = match[2]
    const replaceableString = `/${matchingString}`
    return {
      leadOffset: text.length - replaceableString.length,
      matchingString,
      replaceableString,
    }
  }, [])

  const options = useMemo(() => {
    const normalized = (query ?? '').toLowerCase()
    return skills
      .filter(
        (skill) =>
          normalized === '' ||
          skill.name.toLowerCase().includes(normalized) ||
          skill.description.toLowerCase().includes(normalized),
      )
      .map((skill) => new SkillMenuOption(skill))
  }, [skills, query])

  const onSelectOption = useCallback(
    (option: SkillMenuOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const skillNode = $createSkillNode(option.name)
        if (textNodeContainingQuery) {
          textNodeContainingQuery.replace(skillNode)
        } else {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            selection.insertNodes([skillNode])
          }
        }
        const space = $createTextNode(' ')
        skillNode.insertAfter(space)
        space.selectEnd()
      })
      closeMenu()
    },
    [editor],
  )

  return (
    <LexicalTypeaheadMenuPlugin<SkillMenuOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={() => {
        menuOpenRef.current = true
      }}
      onClose={() => {
        menuOpenRef.current = false
      }}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current
          ? createPortal(
              <ul className="composer-skill-menu" role="listbox" aria-label={t('sidebar.skills')}>
                {loading ? (
                  <li className="composer-skill-menu-empty">{t('composer.skillMenu.loading')}</li>
                ) : options.length === 0 ? (
                  <li className="composer-skill-menu-empty">{t('composer.skillMenu.empty')}</li>
                ) : (
                  options.map((option, index) => (
                    <li
                      key={option.key}
                      role="option"
                      aria-selected={index === selectedIndex}
                      ref={(element) => option.setRefElement(element)}
                      className={`composer-skill-menu-item${index === selectedIndex ? ' active' : ''}`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setHighlightedIndex(index)
                        selectOptionAndCleanUp(option)
                      }}
                    >
                      <span className="composer-skill-menu-name">{option.name}</span>
                      <span className="composer-skill-menu-desc">{option.description}</span>
                    </li>
                  ))
                )}
              </ul>,
              anchorElementRef.current,
            )
          : null
      }
    />
  )
}

export function SkillEditor({ draft, onDraftChange, onSend, listSkills, placeholder }: SkillEditorProps) {
  const draftRef = useRef(draft)
  const lastSerializedRef = useRef(draft)
  const menuOpenRef = useRef(false)

  const initialConfig = useMemo(
    () => ({
      namespace: 'composer-skill-editor',
      nodes: [SkillNode],
      onError: (error: Error) => {
        // Surface in dev; never crash the composer.
        console.error('[skill-editor]', error)
      },
      editorState: () => buildRootFromDraft(draftRef.current),
    }),
    [],
  )

  const handleChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const serialized = $getRoot().getTextContent()
        if (serialized === lastSerializedRef.current) {
          return
        }
        lastSerializedRef.current = serialized
        onDraftChange(serialized)
      })
    },
    [onDraftChange],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PlainTextPlugin
        contentEditable={<ContentEditable className="composer-editor" aria-label={placeholder} />}
        placeholder={<div className="composer-editor-ph">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      <SkillTypeaheadPlugin listSkills={listSkills} menuOpenRef={menuOpenRef} />
      <SubmitPlugin onSend={onSend} menuOpenRef={menuOpenRef} />
      <SkillDeletePlugin />
      <ExternalDraftPlugin draft={draft} lastSerializedRef={lastSerializedRef} />
    </LexicalComposer>
  )
}
