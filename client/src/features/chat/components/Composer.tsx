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
import { Textarea } from '@/components/ui/textarea'
import type { UserDocument } from '@/shared/api/client'
import type { ChatMode } from '@/shared/local-data/types'
import type { LocalWorkspaceAuthorization, LocalWorkspaceDiagnosis } from '@/shared/local-host/client'

export function Composer({
  mode,
  onModeChange,
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
}: {
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
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
}) {
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
      setWorkspaceStatus('请先填写或选择一个文件夹路径。')
      return
    }
    setWorkspaceBusy(true)
    try {
      const diagnosis = await onDiagnoseWorkspace(path)
      setWorkspaceStatus(workspaceDiagnosisMessage(diagnosis))
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '工作区诊断失败')
    } finally {
      setWorkspaceBusy(false)
    }
  }

  async function authorizeWorkspace() {
    const path = workspacePath.trim()
    if (!path) {
      setWorkspaceStatus('请先填写或选择一个文件夹路径。')
      return
    }
    setWorkspaceBusy(true)
    try {
      const workspace = await onAuthorizeWorkspace(path)
      setWorkspaceStatus(`已绑定：${workspace.label}`)
      setWorkspaceDialogOpen(false)
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '工作区授权失败')
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
                <span>已附加 {attachedDocument.original_name}</span>
                <small>
                  {formatBytes(attachedDocument.size_bytes)} · {attachedDocument.status} · {formatDate(attachedDocument.expires_at)}
                </small>
                <Button size="icon-xs" variant="ghost" title="移除附件" onClick={onDetachDocument}>
                  <IconX size={14} />
                </Button>
              </div>
              {attachedDocument.status === 'failed' ? (
                <div className="document-status failed">{attachedDocument.error_message || '解析失败'}</div>
              ) : null}
            </>
          ) : null}
          {!attachedDocument && localProject ? (
            <div className={`local-project-chip ${localProject.authorized ? '' : 'pending'}`}>
              <IconFolderOpen size={15} />
              <span>本地项目：{localProject.label}</span>
              <small>{localProject.authorized ? '已授权' : '待授权'} · {localProject.path}</small>
              <Button size="icon-xs" variant="ghost" title="移除本地项目引用" onClick={onClearLocalProject}>
                <IconX size={14} />
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <div className="composer-input">
        <Textarea
          value={draft}
          placeholder="描述你的问题、任务，或让简单阅读附件"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              onSend()
            }
          }}
        />
      </div>
      <div className="composer-toolbar">
        <div className="composer-controls">
          <ModeToggle mode={mode} onChange={onModeChange} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="为当前对话选择或上传附件"
            onClick={() => setAttachmentDialogOpen(true)}
          >
            <IconPaperclip data-icon="inline-start" />
            附件
            {documents.length > 0 ? <span className="button-count">{documents.length}</span> : null}
          </Button>
          {!attachedDocument ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canUseLocalWorkspace}
              title={canUseLocalWorkspace ? '为当前对话绑定本地工作区' : localStatusLabel}
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              <IconFolderOpen data-icon="inline-start" />
              工作区
            </Button>
          ) : null}
        </div>
        <span className="composer-kbd">⌘↵</span>
        <Button className="send-button" aria-label="发送" disabled={isSending || !draft.trim()} onClick={onSend}>
          <IconArrowUp size={16} />
          <span className="sr-only">发送</span>
        </Button>
      </div>
      <Dialog open={attachmentDialogOpen} onOpenChange={setAttachmentDialogOpen}>
        <DialogContent className="attachment-dialog sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>当前对话附件</DialogTitle>
            <DialogDescription>
              附件只会绑定到当前这次提问。上传后的文件仍由云端完成解析，聊天历史继续保存在本地。
            </DialogDescription>
          </DialogHeader>
          <div className="attachment-dialog-body">
            <label className="document-upload document-upload-dialog">
              <IconUpload size={18} />
              <span>{isUploading ? '上传解析中' : '上传附件'}</span>
              <input
                aria-label="上传附件"
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
                <p className="empty-inline">还没有可用附件。</p>
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
                    <button className="document-delete" title={`删除 ${document.original_name}`} onClick={() => onDeleteDocument(document)}>
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
                移除当前附件
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => setAttachmentDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent className="workspace-dialog sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>当前对话工作区</DialogTitle>
            <DialogDescription>
              工作区只绑定到当前对话。Local Host 仍会在本机校验路径授权，发送任务时只使用这个对话的工作区。
            </DialogDescription>
          </DialogHeader>
          <div className="workspace-dialog-body">
            <label className="workspace-path-field">
              <span>
                <IconFolderOpen />
                文件夹路径
              </span>
              <div className="workspace-path-row">
                <Input
                  aria-label="当前对话工作区路径"
                  value={workspacePath}
                  disabled={workspaceBusy}
                  placeholder="/Users/you/project"
                  onChange={(event) => setWorkspacePath(event.target.value)}
                />
                {canPickWorkspace ? (
                  <Button type="button" variant="outline" disabled={workspaceBusy} onClick={() => void pickWorkspace()}>
                    选择文件夹
                  </Button>
                ) : null}
              </div>
            </label>
            <small className="workspace-dialog-note">
              {workspaceStatus || (canUseLocalWorkspace ? `状态：${localStatusLabel}` : `暂不可用：${localStatusLabel}`)}
            </small>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={workspaceBusy} onClick={() => void diagnoseWorkspace()}>
              诊断路径
            </Button>
            <Button type="button" disabled={workspaceBusy || !canUseLocalWorkspace} onClick={() => void authorizeWorkspace()}>
              {workspaceBusy ? '处理中' : '授权并绑定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </footer>
  )
}

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.docx,.xlsx'

function ModeToggle({ mode, onChange }: { mode: ChatMode; onChange: (mode: ChatMode) => void }) {
  return (
    <div className="segmented">
      <Button className="btn-chip" variant={mode === 'fast' ? 'default' : 'outline'} size="sm" onClick={() => onChange('fast')}>
        快速
      </Button>
      <Button className="btn-chip" variant={mode === 'deep' ? 'default' : 'outline'} size="sm" onClick={() => onChange('deep')}>
        深度
      </Button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value))
  } catch {
    return value
  }
}

function workspaceDiagnosisMessage(diagnosis: LocalWorkspaceDiagnosis): string {
  if (diagnosis.authorized) {
    return `路径已授权：${diagnosis.workspace?.label ?? workspaceLabelFromPath(diagnosis.path)}`
  }
  if (diagnosis.reason === 'not_found') {
    return '路径不存在，请重新选择工作区。'
  }
  if (diagnosis.reason === 'not_directory') {
    return '路径不是文件夹，请选择工作区目录。'
  }
  return '路径存在，但尚未授权。'
}

function workspaceLabelFromPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.split('/').filter(Boolean).at(-1) ?? trimmed
}
