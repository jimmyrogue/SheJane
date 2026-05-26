import { useEffect, useRef, useState } from 'react'
import {
  IconCornerDownLeft,
  IconFileText,
  IconFolder,
  IconFolderPlus,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ModeSelector } from './ModeSelector'
import { SkillEditor } from './SkillEditor'
import { useI18n, type Translator } from '@/shared/i18n/i18n'
import type { UserDocument } from '@/shared/api/client'
import type { InstalledSkill, McpServerInfo } from '@/shared/local-host/client'
import type { ChatMode } from '@/shared/local-data/types'

/**
 * Format the time-until-expiry of a document into a human-readable
 * hint string. Granularity steps down as the expiry approaches:
 *   - > 24h: "Expires in {days} days" (rounded, never zero — at
 *     <24h we drop into the hours branch instead)
 *   - 1-24h: "Expires in {hours}h"
 *   - 0-1h: "Expires soon"
 *   - past: "Expired"
 *
 * Returns `null` if expiresAtIso is empty/invalid so the caller can
 * choose to render nothing. Pulled out as a pure function so the
 * tests can lock in the cutoffs without rendering a whole chip.
 *
 * `t` is the i18n lookup — Composer hands in its `useI18n` callback
 * so the wording matches the rest of the UI's locale.
 */
export function formatDocumentExpiry(
  expiresAtIso: string | undefined | null,
  now: Date,
  t: Translator,
): string | null {
  if (!expiresAtIso) {
    return null
  }
  const expiresAt = new Date(expiresAtIso)
  if (Number.isNaN(expiresAt.getTime())) {
    return null
  }
  const diffMs = expiresAt.getTime() - now.getTime()
  if (diffMs <= 0) {
    return t('composer.expired')
  }
  const oneHourMs = 60 * 60 * 1000
  const oneDayMs = 24 * oneHourMs
  if (diffMs < oneHourMs) {
    return t('composer.expiresSoon')
  }
  if (diffMs < oneDayMs) {
    const hours = Math.max(1, Math.floor(diffMs / oneHourMs))
    return t('composer.expiresInHours', { hours: String(hours) })
  }
  const days = Math.max(1, Math.floor(diffMs / oneDayMs))
  return t('composer.expiresInDays', { days: String(days) })
}

export function Composer({
  draft,
  onDraftChange,
  isSending,
  hasActiveLocalRun = false,
  attachedDocument,
  attachedPreview,
  isUploading,
  uploadProgress,
  onUploadDocument,
  onDetachDocument,
  onSend,
  onStop,
  listSkills,
  listMcpServers,
  mode,
  onModeChange,
  projectName,
  onSelectProject,
}: {
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  /** True when a local-harness run is still alive on the daemon, even
   *  if the client's `sendMessage()` promise has already resolved.
   *  Specifically: a run paused at a HITL `permission.required` or
   *  `question.requested` boundary is conceptually in flight — the
   *  user must still be able to cancel it — but `isSending` flips
   *  back to false the moment the SSE stream blocks. Driving the
   *  stop button off `isSending || hasActiveLocalRun` keeps the
   *  button visible during those pauses. App.tsx derives the bool
   *  from the active conversation's most recent assistant message
   *  status (streaming / waiting_permission / waiting_input). */
  hasActiveLocalRun?: boolean
  attachedDocument?: UserDocument
  /** Inline data: URL for image previews. Non-image documents leave
   *  this undefined and we fall back to a file-icon tile. */
  attachedPreview?: string
  isUploading: boolean
  /** 0..100 percentage during an in-flight upload, undefined when
   *  idle. Used to render a determinate progress overlay on the
   *  attachment chip — slow cross-border S3 uploads (30+ seconds
   *  from China even with Transfer Acceleration) otherwise look
   *  like the app froze. When undefined but `isUploading` is true,
   *  the indeterminate spinner is shown instead. */
  uploadProgress?: number
  onUploadDocument: (file?: File) => void
  onDetachDocument: () => void
  onSend: () => void
  /** Cancel the in-flight run. Shown as a "stop" button in place of
   *  "send" while `isSending` OR `hasActiveLocalRun` is true. */
  onStop?: () => void
  listSkills: () => Promise<InstalledSkill[]>
  /** Optional — when omitted the MCP slash group hides instead of
   *  rendering an empty section. Provided by App.tsx only when the
   *  daemon is online. */
  listMcpServers?: () => Promise<McpServerInfo[]>
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  /** Project (workspace) currently bound to this chat. When undefined,
   *  the toolbar shows an "add project" button that opens the directory
   *  picker. When set, the button locks into a chip showing the project
   *  name — switching projects requires a new chat. */
  projectName?: string
  /** Open the OS directory picker and bind the chosen workspace as this
   *  chat's project. Only invoked when `projectName` is undefined; the
   *  locked-chip click is a no-op (disabled). */
  onSelectProject?: () => void
}) {
  const { t } = useI18n()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  // Stop is offered while the send promise is still awaiting (covers
  // the brief window before the SSE stream has produced its first
  // message) OR while the active local run is still alive on the
  // daemon (covers HITL pauses where the SSE stream has blocked but
  // the run can still be cancelled). Without the second clause the
  // button reverts to "send" the moment a permission card appears,
  // stranding users with no way to abort.
  const canStop = (isSending || hasActiveLocalRun) && Boolean(onStop)
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
            {(() => {
              // Compute the expiry hint once per render. Only surface
              // it after the document is "ready" — while uploading or
              // processing, the expires_at field exists but is moot
              // (the user can't even reuse the file yet), and showing
              // "expires in 7 days" next to a spinner reads as noise.
              const expiryHint =
                attachedDocument.status === 'ready'
                  ? formatDocumentExpiry(attachedDocument.expires_at, new Date(), t)
                  : null
              const tooltip = expiryHint
                ? `${attachedDocument.original_name} · ${expiryHint}`
                : attachedDocument.original_name
              return (
            <div className="attachment-tile">
            <div
              className={`attachment-thumb status-${attachedDocument.status}`}
              title={tooltip}
            >
              {attachedPreview ? (
                <img src={attachedPreview} alt={attachedDocument.original_name} className="attachment-thumb-image" />
              ) : (
                <div className="attachment-thumb-placeholder" aria-hidden="true">
                  <IconFileText size={26} />
                </div>
              )}
              {attachedDocument.status !== 'ready' && attachedDocument.status !== 'failed' ? (
                <div
                  className="attachment-thumb-overlay"
                  aria-hidden="true"
                  aria-label={
                    typeof uploadProgress === 'number'
                      ? t('composer.uploadProgress', { percent: String(Math.round(uploadProgress)) })
                      : t('composer.uploading')
                  }
                >
                  {typeof uploadProgress === 'number' ? (
                    // Determinate: show the rounded percentage so users
                    // can tell whether the upload is making progress.
                    // The conic-gradient ring under it is driven by a
                    // CSS custom property so we don't trigger React
                    // reconciliation on every byte chunk — the
                    // attachment-thumb-progress class reads --percent.
                    <span
                      className="attachment-thumb-progress"
                      style={{ ['--percent' as never]: `${Math.round(uploadProgress)}%` }}
                    >
                      {Math.round(uploadProgress)}%
                    </span>
                  ) : (
                    <IconLoader2 size={18} className="attachment-thumb-spin" />
                  )}
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
              {expiryHint ? (
                // Visible caption below the chip so the retention
                // window is discoverable without hovering. Cloud
                // documents auto-expire ~7 days after upload; without
                // this, users only learned the limit when a stale
                // attachment failed mid-run. No aria-label needed —
                // the visible text content is already accessible to
                // screen readers; adding aria-label would double-read.
                <span className="attachment-expiry-caption">{expiryHint}</span>
              ) : null}
            </div>
              )
            })()}
          </div>
        ) : null}
        <SkillEditor
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          listSkills={listSkills}
          listMcpServers={listMcpServers}
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
        {projectName ? (
          // Locked chip — once bound, project can't be changed without
          // starting a new chat (the daemon already has the workspace
          // path attached to this conversation's run state).
          <span
            className="composer-tool composer-project-chip"
            title={t('composer.projectPicker.locked', { name: projectName })}
            aria-label={t('composer.projectPicker.locked', { name: projectName })}
          >
            <IconFolder size={14} aria-hidden="true" />
            <span className="composer-project-chip-name">{projectName}</span>
          </span>
        ) : (
          <button
            type="button"
            className="composer-tool composer-project-button"
            aria-label={t('composer.projectPicker.add')}
            title={t('composer.projectPicker.tooltip')}
            disabled={!onSelectProject || isSending}
            onClick={() => onSelectProject?.()}
          >
            <IconFolderPlus size={16} aria-hidden="true" />
          </button>
        )}
        <ModeSelector mode={mode} onChange={onModeChange} disabled={isSending} />
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
