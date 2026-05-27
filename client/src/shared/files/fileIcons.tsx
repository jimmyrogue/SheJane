/**
 * Typed file-icon helper used by every attachment chip in the app
 * (composer attachment chip, message-bubble attachment chip, doc
 * preview header). Centralizes the extension/MIME → icon + color
 * mapping so adding new file types only needs one edit here.
 *
 * Icons come from @tabler/icons-react. Color names map onto CSS
 * custom properties defined in styles.css under the
 * `--file-icon-color-*` family — that way dark mode + theme tweaks
 * land in one place instead of being burned into the icon JSX.
 *
 * Fallback: any extension we don't explicitly recognize gets the
 * generic IconFile in muted gray. Better than `IconPaperclip` which
 * was the old placeholder — paperclip reads as "I have an
 * attachment" not "this is a file."
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
  /** CSS class suffix; pairs with `.file-icon-*` rules in styles.css
   *  to color the icon. Kept as a string (not a hex) so theme + dark
   *  mode can override centrally. */
  colorKey: FileIconKind
}

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
  if (name.endsWith('.pdf')) return { Icon: IconFileTypePdf, colorKey: 'pdf' }
  if (name.endsWith('.docx') || name.endsWith('.doc')) return { Icon: IconFileTypeDocx, colorKey: 'word' }
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv'))
    return { Icon: IconFileTypeXls, colorKey: 'excel' }
  if (name.endsWith('.pptx') || name.endsWith('.ppt')) return { Icon: IconFileTypePpt, colorKey: 'powerpoint' }
  if (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp') ||
    name.endsWith('.gif') ||
    name.endsWith('.bmp') ||
    name.endsWith('.svg')
  )
    return { Icon: IconPhoto, colorKey: 'image' }

  // MIME fallback for renames / quirky uploads.
  if (mime === 'application/pdf') return { Icon: IconFileTypePdf, colorKey: 'pdf' }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword')
    return { Icon: IconFileTypeDocx, colorKey: 'word' }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'text/csv'
  )
    return { Icon: IconFileTypeXls, colorKey: 'excel' }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/vnd.ms-powerpoint'
  )
    return { Icon: IconFileTypePpt, colorKey: 'powerpoint' }
  if (mime.startsWith('image/')) return { Icon: IconPhoto, colorKey: 'image' }

  return { Icon: IconFile, colorKey: 'other' }
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
