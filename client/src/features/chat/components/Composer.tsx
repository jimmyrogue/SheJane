import { useEffect, useState } from 'react'
import {
  IconArrowUp,
  IconFileText,
  IconFolderOpen,
  IconLoader2,
  IconPaperclip,
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
import { Input } from '@/components/ui/input'
import { SkillEditor } from './SkillEditor'
import { useI18n, type Translator, type Locale } from '@/shared/i18n/i18n'
import type { UserDocument } from '@/shared/api/client'
import type { InstalledSkill, LocalWorkspaceAuthorization, LocalWorkspaceDiagnosis } from '@/shared/local-host/client'

export function Composer({
  draft,
  onDraftChange,
  isSending,
  documents,
  attachedDocumentID,
  attachedDocument,
  isUploading,
  localStatusLabel,
  canUseLocalWorkspace,
  canPickWorkspace,
  localProject,
  onUploadDocument,
  onAttachDocument,
  onDeleteDocument,
  onDetachDocument,
  onPickWorkspace,
  onDiagnoseWorkspace,
  onAuthorizeWorkspace,
  onClearLocalProject,
  onSend,
  listSkills,
}: {
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  documents: UserDocument[]
  attachedDocumentID?: string
  attachedDocument?: UserDocument
  isUploading: boolean
  localStatusLabel: string
  canUseLocalWorkspace: boolean
  canPickWorkspace: boolean
  localProject?: {
    label: string
    path: string
    authorized: boolean
  }
  onUploadDocument: (file?: File) => void
  onAttachDocument: (documentID: string) => void
  onDeleteDocument: (document: UserDocument) => void
  onDetachDocument: () => void
  onPickWorkspace: () => Promise<string | undefined>
  onDiagnoseWorkspace: (path: string) => Promise<LocalWorkspaceDiagnosis>
  onAuthorizeWorkspace: (path: string) => Promise<LocalWorkspaceAuthorization>
  onClearLocalProject: () => void
  onSend: () => void
  listSkills: () => Promise<InstalledSkill[]>
}) {
  const { locale, t } = useI18n()

  const hasChips = Boolean(attachedDocument || localProject)
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [workspacePath, setWorkspacePath] = useState(localProject?.path ?? '')
  const [workspaceStatus, setWorkspaceStatus] = useState('')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)

  useEffect(() => {
    if (workspaceDialogOpen) {
      setWorkspacePath(localProject?.path ?? '')
      setWorkspaceStatus('')
    }
  }, [localProject?.path, workspaceDialogOpen])

  async function pickWorkspace() {
    setWorkspaceStatus('')
    const path = await onPickWorkspace()
    if (path) {
      setWorkspacePath(path)
    }
  }

  async function diagnoseWorkspace() {
    const path = workspacePath.trim()
    if (!path) {
      setWorkspaceStatus(t('composer.workspace.emptyPath'))
      return
    }
    setWorkspaceBusy(true)
    try {
      const diagnosis = await onDiagnoseWorkspace(path)
      setWorkspaceStatus(workspaceDiagnosisMessage(diagnosis, t))
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : t('composer.workspace.diagnoseFailed'))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  async function authorizeWorkspace() {
    const path = workspacePath.trim()
    if (!path) {
      setWorkspaceStatus(t('composer.workspace.emptyPath'))
      return
    }
    setWorkspaceBusy(true)
    try {
      const workspace = await onAuthorizeWorkspace(path)
      setWorkspaceStatus(t('composer.workspace.bound', { label: workspace.label }))
      setWorkspaceDialogOpen(false)
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : t('composer.workspace.authFailed'))
    } finally {
      setWorkspaceBusy(false)
    }
  }

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
          {!attachedDocument && localProject ? (
            <div className={`local-project-chip ${localProject.authorized ? '' : 'pending'}`}>
              <IconFolderOpen size={15} />
              <span>{t('composer.localProject', { label: localProject.label })}</span>
              <small>{localProject.authorized ? t('composer.authorized') : t('composer.pendingAuth')} · {localProject.path}</small>
              <Button size="icon-xs" variant="ghost" title={t('composer.removeWorkspace')} onClick={onClearLocalProject}>
                <IconX size={14} />
              </Button>
            </div>
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
            size="sm"
            title={t('composer.attachmentTitle')}
            onClick={() => setAttachmentDialogOpen(true)}
          >
            <IconPaperclip data-icon="inline-start" />
            {t('composer.attachmentButton')}
            {documents.length > 0 ? <span className="button-count">{documents.length}</span> : null}
          </Button>
          {!attachedDocument ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canUseLocalWorkspace}
              title={canUseLocalWorkspace ? t('composer.workspaceTitle') : localStatusLabel}
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              <IconFolderOpen data-icon="inline-start" />
              {t('composer.workspaceButton')}
            </Button>
          ) : null}
        </div>
        <span className="composer-kbd">⌘↵</span>
        <Button className="send-button" aria-label={t('composer.send')} disabled={isSending || !draft.trim()} onClick={onSend}>
          <IconArrowUp size={16} />
          <span className="sr-only">{t('composer.send')}</span>
        </Button>
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
      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent className="workspace-dialog sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('composer.workspaceDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('composer.workspaceDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="workspace-dialog-body">
            <label className="workspace-path-field">
              <span>
                <IconFolderOpen />
                {t('composer.workspacePath')}
              </span>
              <div className="workspace-path-row">
                <Input
                  aria-label={t('composer.workspacePathLabel')}
                  value={workspacePath}
                  disabled={workspaceBusy}
                  placeholder="/Users/you/project"
                  onChange={(event) => setWorkspacePath(event.target.value)}
                />
                {canPickWorkspace ? (
                  <Button type="button" variant="outline" disabled={workspaceBusy} onClick={() => void pickWorkspace()}>
                    {t('composer.pickFolder')}
                  </Button>
                ) : null}
              </div>
            </label>
            <small className="workspace-dialog-note">
              {workspaceStatus || (canUseLocalWorkspace ? t('composer.workspaceStatus', { status: localStatusLabel }) : t('composer.workspaceUnavailable', { status: localStatusLabel }))}
            </small>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={workspaceBusy} onClick={() => void diagnoseWorkspace()}>
              {t('composer.diagnosePath')}
            </Button>
            <Button type="button" disabled={workspaceBusy || !canUseLocalWorkspace} onClick={() => void authorizeWorkspace()}>
              {workspaceBusy ? t('composer.processing') : t('composer.authorizeBind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </footer>
  )
}

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.docx,.xlsx'


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

function workspaceDiagnosisMessage(diagnosis: LocalWorkspaceDiagnosis, t: Translator): string {
  if (diagnosis.authorized) {
    return t('composer.workspace.pathAuthorized', { label: diagnosis.workspace?.label ?? workspaceLabelFromPath(diagnosis.path) })
  }
  if (diagnosis.reason === 'not_found') {
    return t('composer.workspace.notFound')
  }
  if (diagnosis.reason === 'not_directory') {
    return t('composer.workspace.notDirectory')
  }
  return t('composer.workspace.notAuthorized')
}

function workspaceLabelFromPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.split('/').filter(Boolean).at(-1) ?? trimmed
}
