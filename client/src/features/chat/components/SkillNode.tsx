import type { JSX } from 'react'
import { IconPhoto, IconSparkles } from '@tabler/icons-react'
import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { functionToken, skillToken } from '../skillDraft'

// Display labels for function ids. Extensible: add more capabilities here.
export const FUNCTION_LABELS: Record<string, string> = {
  image: '生图',
}

function functionLabel(id: string): string {
  return FUNCTION_LABELS[id] ?? id
}

export type SerializedSkillNode = Spread<{ name: string }, SerializedLexicalNode>

function SkillChip({ name }: { name: string }): JSX.Element {
  return (
    <span className="skill-chip--inline" data-skill={name}>
      <IconSparkles className="skill-chip-icon" size={12} aria-hidden="true" />
      {name}
    </span>
  )
}

export class SkillNode extends DecoratorNode<JSX.Element> {
  __name: string

  static getType(): string {
    return 'skill'
  }

  static clone(node: SkillNode): SkillNode {
    return new SkillNode(node.__name, node.__key)
  }

  static importJSON(serialized: SerializedSkillNode): SkillNode {
    return $createSkillNode(serialized.name)
  }

  constructor(name: string, key?: NodeKey) {
    super(key)
    this.__name = name
  }

  exportJSON(): SerializedSkillNode {
    return { type: 'skill', version: 1, name: this.__name }
  }

  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  getTextContent(): string {
    return skillToken(this.__name)
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <SkillChip name={this.__name} />
  }
}

export function $createSkillNode(name: string): SkillNode {
  return $applyNodeReplacement(new SkillNode(name))
}

export function $isSkillNode(node: LexicalNode | null | undefined): node is SkillNode {
  return node instanceof SkillNode
}

export type SerializedFunctionNode = Spread<{ name: string }, SerializedLexicalNode>

function FunctionChip({ id }: { id: string }): JSX.Element {
  return (
    <span className="function-chip--inline" data-function={id}>
      <IconPhoto className="skill-chip-icon" size={12} aria-hidden="true" />
      {functionLabel(id)}
    </span>
  )
}

export class FunctionNode extends DecoratorNode<JSX.Element> {
  __name: string

  static getType(): string {
    return 'function'
  }

  static clone(node: FunctionNode): FunctionNode {
    return new FunctionNode(node.__name, node.__key)
  }

  static importJSON(serialized: SerializedFunctionNode): FunctionNode {
    return $createFunctionNode(serialized.name)
  }

  constructor(name: string, key?: NodeKey) {
    super(key)
    this.__name = name
  }

  exportJSON(): SerializedFunctionNode {
    return { type: 'function', version: 1, name: this.__name }
  }

  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  getTextContent(): string {
    return functionToken(this.__name)
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <FunctionChip id={this.__name} />
  }
}

export function $createFunctionNode(name: string): FunctionNode {
  return $applyNodeReplacement(new FunctionNode(name))
}

export function $isFunctionNode(node: LexicalNode | null | undefined): node is FunctionNode {
  return node instanceof FunctionNode
}
