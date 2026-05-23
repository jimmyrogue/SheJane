import { useState } from 'react'
import {
  IconArrowUp,
  IconFileText,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SkillEditor } from './SkillEditor'
import { useI18n, type Locale } from '@/shared/i18n/i18n'
import type { UserDocument } from '@/shared/api/client'
import type { InstalledSkill } from '@/shared/local-host/client'

export function Composer({
  draft,
  onDraftChange,
  isSending,
  documents,
  attachedDocumentID,
  attachedDocument,
  isUploading,
  onUploadDocument,
  onAttachDocument,
  onDeleteDocument,
  onDetachDocument,
  onSend,
  onStop,
  listSkills,
}: {
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  documents: UserDocument[]
  attachedDocumentID?: string
  attachedDocument?: UserDocument
  isUploading: boolean
  onUploadDocument: (file?: File) => void
  onAttachDocument: (documentID: string) => void
  onDeleteDocument: (document: UserDocument) => void
  onDetachDocument: () => void
  onSend: () => void
  /** Cancel the in-flight run. Shown as a "stop" button in place of
   *  "send" while `isSending` is true. Optional — if not supplied, the
   *  send button just stays disabled during streaming. */
  onStop?: () => void
  listSkills: () => Promise<InstalledSkill[]>
}) {
  const { locale, t } = useI18n()

  const hasChips = Boolean(attachedDocument)
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false)
  const canStop = isSending && Boolean(onStop)

  return (
    <footer className="composer">
      {hasChips && (
        <div className="composer-chips">
          {attachedDocument ? (
            <>
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
            </>
          ) : null}
        </div>
      )}
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
            onClick={() => setAttachmentDialogOpen(true)}
          >
            <IconPaperclip size={16} aria-hidden="true" />
            {documents.length > 0 ? <span className="button-count">{documents.length}</span> : null}
          </Button>
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
      <Dialog open={attachmentDialogOpen} onOpenChange={setAttachmentDialogOpen}>
        <DialogContent className="attachment-dialog sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('composer.attachmentDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('composer.attachmentDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="attachment-dialog-body">
            <label className="document-upload document-upload-dialog">
              <IconUpload size={18} />
              <span>{isUploading ? t('composer.uploading') : t('composer.upload')}</span>
              <input
                aria-label={t('composer.upload')}
                type="file"
                accept={documentAccept}
                disabled={isUploading}
                onChange={(event) => {
                  onUploadDocument(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </label>
            <div className="document-list document-list-dialog">
              {documents.length === 0 ? (
                <p className="empty-inline">{t('composer.noAttachments')}</p>
              ) : (
                documents.map((document) => (
                  <div className={document.id === attachedDocumentID ? 'document-list-item active' : 'document-list-item'} key={document.id}>
                    <button
                      className="document-select"
                      onClick={() => {
                        onAttachDocument(document.id)
                        setAttachmentDialogOpen(false)
                      }}
                    >
                      <IconFileText size={16} />
                      <span>{document.original_name}</span>
                      <small>{document.status}</small>
                    </button>
                    <button className="document-delete" title={t('composer.deleteDocument', { name: document.original_name })} onClick={() => onDeleteDocument(document)}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            {attachedDocument ? (
              <Button type="button" variant="outline" onClick={onDetachDocument}>
                {t('composer.detachCurrent')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => setAttachmentDialogOpen(false)}>
              {t('composer.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
