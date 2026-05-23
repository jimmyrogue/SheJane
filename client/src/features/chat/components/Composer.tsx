import { useRef } from 'react'
import {
  IconArrowUp,
  IconFileText,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { SkillEditor } from './SkillEditor'
import { useI18n, type Locale } from '@/shared/i18n/i18n'
import type { UserDocument } from '@/shared/api/client'
import type { InstalledSkill } from '@/shared/local-host/client'

export function Composer({
  draft,
  onDraftChange,
  isSending,
  attachedDocument,
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
  /** The single document attached to the next outgoing message, if any. */
  attachedDocument?: UserDocument
  isUploading: boolean
  onUploadDocument: (file?: File) => void
  onDetachDocument: () => void
  onSend: () => void
  /** Cancel the in-flight run. Shown as a "stop" button in place of
   *  "send" while `isSending` is true. Optional — if not supplied, the
   *  send button just stays disabled during streaming. */
  onStop?: () => void
  listSkills: () => Promise<InstalledSkill[]>
}) {
  const { locale, t } = useI18n()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const canStop = isSending && Boolean(onStop)

  function openFilePicker() {
    if (isUploading) {
      return
    }
    fileInputRef.current?.click()
  }

  return (
    <footer className="composer">
      {attachedDocument ? (
        <div className="composer-chips">
          <div className={`attachment-chip ${attachedDocument.status !== 'ready' ? 'pending' : ''}`}>
            {attachedDocument.status !== 'ready' && attachedDocument.status !== 'failed' ? <IconLoader2 size={15} /> : <IconFileText size={15} />}
            <span>{t('composer.attachedDocument', { name: attachedDocument.original_name })}</span>
            <small>
              {formatBytes(attachedDocument.size_bytes)} · {attachedDocument.status} · {formatDate(attachedDocument.expires_at, locale)}
            </small>
            <Button size="icon-xs" variant="ghost" title={t('composer.removeAttachment')} onClick={onDetachDocument}>
              <IconX size={14} />
            </Button>
          </div>
          {attachedDocument.status === 'failed' ? (
            <div className="document-status failed">{attachedDocument.error_message || t('composer.parseFailed')}</div>
          ) : null}
        </div>
      ) : null}
      <div className="composer-input">
        <SkillEditor
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          listSkills={listSkills}
          placeholder={t('composer.placeholder')}
        />
      </div>
      <div className="composer-toolbar">
        <div className="composer-controls">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="composer-attach-button"
            aria-label={t('composer.attachmentTitle')}
            title={t('composer.attachmentTitle')}
            disabled={isUploading}
            onClick={openFilePicker}
          >
            {isUploading ? (
              <IconLoader2 size={16} aria-hidden="true" className="composer-attach-spinner" />
            ) : (
              <IconPaperclip size={16} aria-hidden="true" />
            )}
          </Button>
          {/* Hidden native file picker — clicking the visible button
              triggers it via openFilePicker(). Keeps the OS chooser as
              the single, direct attach affordance (no dialog in between).
              aria-label exposed so tests / a11y can find it. */}
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
        <span className="composer-kbd">⌘↵</span>
        {canStop ? (
          <Button
            className="send-button send-button-stop"
            type="button"
            aria-label={t('composer.stop')}
            title={t('composer.stop')}
            onClick={onStop}
          >
            <IconPlayerStopFilled size={14} aria-hidden="true" />
            <span className="sr-only">{t('composer.stop')}</span>
          </Button>
        ) : (
          <Button
            className="send-button"
            aria-label={t('composer.send')}
            disabled={isSending || !draft.trim()}
            onClick={onSend}
          >
            <IconArrowUp size={16} aria-hidden="true" />
            <span className="sr-only">{t('composer.send')}</span>
          </Button>
        )}
      </div>
    </footer>
  )
}

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp'


function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { month: '2-digit', day: '2-digit' }).format(new Date(value))
  } catch {
    return value
  }
}
