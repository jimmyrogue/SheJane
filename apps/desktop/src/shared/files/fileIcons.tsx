/**
 * Typed file helper used by every attachment chip in the app
 * (composer attachment chip, message-bubble attachment chip, doc
 * preview header). Centralizes the extension/MIME → kind + glyph
 * mapping so adding new file types only needs one edit here.
 *
 * Visual rule from the SheJane v4 design: file/attachment types use
 * a single-color typographic glyph, not colorful app-brand icons.
 *
 * Fallback: any extension we don't explicitly recognize gets the
 * generic "文" mark in muted ink. Better than `IconPaperclip` which
 * reads as "I have an attachment" not "this is a file."
 */
import {
  IconFile,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconPhoto,
  type IconProps,
} from '@tabler/icons-react'
import type { ComponentType } from 'react'

export type FileIconKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'image' | 'other'

export interface FileIconDescriptor {
  Icon: ComponentType<IconProps>
  /** Compatibility key for previewability and existing CSS hooks. */
  colorKey: FileIconKind
  /** SheJane's single-color typographic mark for this kind. */
  glyph: string
  /** Human-readable type label. */
  label: string
}

const descriptor = (Icon: ComponentType<IconProps>, colorKey: FileIconKind, glyph: string, label: string): FileIconDescriptor => ({
  Icon,
  colorKey,
  glyph,
  label,
})

/**
 * Pick the icon + color for a file based on its filename and MIME.
 * Filename extension takes precedence (server-normalized MIMEs are
 * authoritative but users sometimes upload with quirky content types
 * — `.pdf` named files with `application/octet-stream` should still
 * read as PDF visually).
 */
export function fileIconFor(filename: string, contentType?: string): FileIconDescriptor {
  const name = (filename || '').toLowerCase()
  const mime = (contentType || '').toLowerCase().split(';')[0].trim()

  // Extension-first matching.
  if (name.endsWith('.pdf')) return descriptor(IconFileTypePdf, 'pdf', '文', 'PDF')
  if (name.endsWith('.docx') || name.endsWith('.doc')) return descriptor(IconFileTypeDocx, 'word', '文', 'Document')
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv'))
    return descriptor(IconFileTypeXls, 'excel', '表', 'Spreadsheet')
  if (name.endsWith('.pptx') || name.endsWith('.ppt')) return descriptor(IconFileTypePpt, 'powerpoint', '演', 'Presentation')
  if (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp') ||
    name.endsWith('.gif') ||
    name.endsWith('.bmp') ||
    name.endsWith('.svg')
  )
    return descriptor(IconPhoto, 'image', '图', 'Image')

  // MIME fallback for renames / quirky uploads.
  if (mime === 'application/pdf') return descriptor(IconFileTypePdf, 'pdf', '文', 'PDF')
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword')
    return descriptor(IconFileTypeDocx, 'word', '文', 'Document')
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'text/csv'
  )
    return descriptor(IconFileTypeXls, 'excel', '表', 'Spreadsheet')
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/vnd.ms-powerpoint'
  )
    return descriptor(IconFileTypePpt, 'powerpoint', '演', 'Presentation')
  if (mime.startsWith('image/')) return descriptor(IconPhoto, 'image', '图', 'Image')

  return descriptor(IconFile, 'other', '文', 'File')
}

/**
 * True iff a filename/MIME represents something we currently render
 * inside the DocPreviewPanel (vs needing to be opened externally).
 * Callers use this to decide whether a chip click opens the side
 * panel or invokes the external-open fallback.
 *
 * Kept in sync with the `kind` branches in DocPreviewPanel.tsx and
 * the `OpenDocument['kind']` union in shared/local-data/types.ts.
 */
export function isInAppPreviewable(filename: string, contentType?: string): boolean {
  const desc = fileIconFor(filename, contentType)
  return desc.colorKey === 'pdf' || desc.colorKey === 'word' || desc.colorKey === 'excel'
  // NOTE: 'powerpoint' is previewable for LOCAL workspace .pptx
  // files only — cloud uploads don't support it (we never accept
  // .pptx uploads on the cloud documents service). 'image' is
  // handled inline in the message bubble, not via the preview
  // panel. 'other' has no preview component.
}
