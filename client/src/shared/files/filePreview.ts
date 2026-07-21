export type FilePreviewKind = 'word' | 'excel' | 'powerpoint' | 'pdf' | 'code' | 'text' | 'image'

const EXTENSION_KIND: Readonly<Record<string, FilePreviewKind>> = {
  docx: 'word',
  xlsx: 'excel',
  pptx: 'powerpoint',
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  csv: 'text',
  log: 'text',
  json: 'code',
  jsonl: 'code',
  js: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  sql: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  xml: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  conf: 'code',
  vue: 'code',
  svelte: 'code',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
}

export function fileExtension(name: string): string {
  const basename = name.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? name
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ''
}

export function filePreviewKind(name: string): FilePreviewKind | undefined {
  return EXTENSION_KIND[fileExtension(name)]
}

export function isPreviewableFile(name: string): boolean {
  return filePreviewKind(name) !== undefined
}

export function codeLanguageForFile(name: string): string | undefined {
  const extension = fileExtension(name)
  const aliases: Readonly<Record<string, string>> = {
    h: 'c',
    cc: 'cpp',
    cs: 'csharp',
    htm: 'html',
    js: 'javascript',
    jsx: 'javascript',
    kt: 'kotlin',
    kts: 'kotlin',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'typescript',
    yml: 'yaml',
  }
  return aliases[extension] ?? (extension || undefined)
}
