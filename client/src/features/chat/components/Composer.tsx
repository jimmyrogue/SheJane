import { useEffect, useRef, useState } from 'react'
import {
  IconCornerDownLeft,
  IconFileText,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { SkillEditor } from './SkillEditor'
import { useI18n } from '@/shared/i18n/i18n'
import type { UserDocument } from '@/shared/api/client'
import type { InstalledSkill } from '@/shared/local-host/client'

export function Composer({
  draft,
  onDraftChange,
  isSending,
  attachedDocument,
  attachedPreview,
  isUploading,
  onUploadDocument,
  onDetachDocument,
  onSend,
  onStop,
  listSkills,
}: {
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  attachedDocument?: UserDocument
  /** Inline data: URL for image previews. Non-image documents leave
   *  this undefined and we fall back to a file-icon tile. */
  attachedPreview?: string
  isUploading: boolean
  onUploadDocument: (file?: File) => void
  onDetachDocument: () => void
  onSend: () => void
  /** Cancel the in-flight run. Shown as a "stop" button in place of
   *  "send" while `isSending` is true. */
  onStop?: () => void
  listSkills: () => Promise<InstalledSkill[]>
}) {
  const { t } = useI18n()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const canStop = isSending && Boolean(onStop)
  const [isDragging, setIsDragging] = useState(false)
  const dragDepthRef = useRef(0)

  function openFilePicker() {
    if (isUploading) {
      return
    }
    fileInputRef.current?.click()
  }

  /** Paste an image straight into the composer — typical for screenshot
   *  workflows where the clipboard already holds the image bitmap.
   *  Capture-phase listener so we run before Lexical's own paste
   *  handling and can claim the event for non-text content. */
  useEffect(() => {
    const node = composerRef.current
    if (!node) {
      return
    }
    const handler = (event: ClipboardEvent) => {
      if (isUploading) {
        return
      }
      const items = event.clipboardData?.items
      if (!items) {
        return
      }
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            event.preventDefault()
            event.stopPropagation()
            onUploadDocument(file)
            return
          }
        }
      }
    }
    node.addEventListener('paste', handler, { capture: true })
    return () => node.removeEventListener('paste', handler, { capture: true })
  }, [isUploading, onUploadDocument])

  /** Drag-and-drop handlers — drop a file anywhere on the composer to
   *  upload it. dragDepthRef counts nested dragenter/dragleave fires
   *  so the highlight only clears when the cursor really leaves the
   *  composer, not when it crosses an inner child boundary. */
  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  function handleDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragging(false)
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)
    if (isUploading) {
      return
    }
    const file = event.dataTransfer.files?.[0]
    if (file) {
      onUploadDocument(file)
    }
  }

  return (
    <footer
      className={`composer${isDragging ? ' composer-dragging' : ''}`}
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="composer-input">
        {attachedDocument ? (
          <div className="composer-chips">
            <div
              className={`attachment-thumb status-${attachedDocument.status}`}
              title={attachedDocument.original_name}
            >
              {attachedPreview ? (
                <img src={attachedPreview} alt={attachedDocument.original_name} className="attachment-thumb-image" />
              ) : (
                <div className="attachment-thumb-placeholder" aria-hidden="true">
                  <IconFileText size={26} />
                </div>
              )}
              {attachedDocument.status !== 'ready' && attachedDocument.status !== 'failed' ? (
                <div className="attachment-thumb-overlay" aria-hidden="true">
                  <IconLoader2 size={18} className="attachment-thumb-spin" />
                </div>
              ) : null}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="attachment-thumb-remove"
                aria-label={t('composer.removeAttachment')}
                title={t('composer.removeAttachment')}
                onClick={onDetachDocument}
              >
                <IconX size={12} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
        <SkillEditor
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          listSkills={listSkills}
          placeholder={t('composer.placeholder')}
        />
        {/* Send / Stop button: sits in the bottom-right corner of the
         *  input frame so it follows the editor as the textarea grows.
         *  The editor reserves matching padding-right so typed text
         *  doesn't slide under the button. */}
        {canStop ? (
          <button
            type="button"
            className="composer-send composer-send-stop"
            aria-label={t('composer.stop')}
            title={t('composer.stop')}
            onClick={onStop}
          >
            <IconPlayerStopFilled size={14} aria-hidden="true" />
            <span className="sr-only">{t('composer.stop')}</span>
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label={t('composer.send')}
            disabled={isSending || !draft.trim()}
            title={t('composer.kbdHint')}
            onClick={onSend}
          >
            <IconCornerDownLeft size={16} aria-hidden="true" />
            <span className="sr-only">{t('composer.send')}</span>
          </button>
        )}
      </div>
      {/* Tools row below the input — borderless, hover-darken icons. */}
      <div className="composer-toolbar">
        <button
          type="button"
          className="composer-tool"
          aria-label={t('composer.attachmentTitle')}
          title={t('composer.attachmentTitle')}
          disabled={isUploading}
          onClick={openFilePicker}
        >
          {isUploading ? (
            <IconLoader2 size={16} aria-hidden="true" className="attachment-thumb-spin" />
          ) : (
            <IconPaperclip size={16} aria-hidden="true" />
          )}
        </button>
        {/* Hidden native file picker — clicking the attach tool above
            triggers it via openFilePicker(). aria-label kept so tests
            and screen readers can find it. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={documentAccept}
          aria-label={t('composer.upload')}
          disabled={isUploading}
          style={{ display: 'none' }}
          onChange={(event) => {
            onUploadDocument(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
      </div>
    </footer>
  )
}

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp'
