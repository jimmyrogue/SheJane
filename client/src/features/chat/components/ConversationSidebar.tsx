import { useRef } from 'react'
import { Download, FileText, FolderOpen, MessageSquare, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UserDocument } from '@/shared/api/client'
import type { Conversation } from '@/shared/local-data/types'
import type { LocalRun, LocalWorkspaceAuthorization } from '@/shared/local-host/client'

export function ConversationSidebar({
  conversations,
  activeID,
  documents,
  attachedDocumentID,
  isUploading,
  localStatusLabel,
  localWorkspacePath,
  canPickWorkspace,
  authorizedWorkspaces,
  localRuns,
  onNewConversation,
  onSelectConversation,
  onUploadDocument,
  onAttachDocument,
  onDeleteDocument,
  onWorkspacePathChange,
  onPickWorkspace,
  onAuthorizeWorkspace,
  onDiagnoseWorkspace,
  onRevokeWorkspace,
  onRecoverLocalRun,
  onExportLocalRunDiagnostics,
  onExportLocalData,
  onImportLocalData,
}: {
  conversations: Conversation[]
  activeID?: string
  documents: UserDocument[]
  attachedDocumentID?: string
  isUploading: boolean
  localStatusLabel: string
  localWorkspacePath: string
  canPickWorkspace: boolean
  authorizedWorkspaces: LocalWorkspaceAuthorization[]
  localRuns: LocalRun[]
  onNewConversation: () => void
  onSelectConversation: (conversationID: string) => void
  onUploadDocument: (file?: File) => void
  onAttachDocument: (documentID: string) => void
  onDeleteDocument: (document: UserDocument) => void
  onWorkspacePathChange: (path: string) => void
  onPickWorkspace: () => void
  onAuthorizeWorkspace: () => void
  onDiagnoseWorkspace: (path?: string) => void
  onRevokeWorkspace: (workspace: LocalWorkspaceAuthorization) => void
  onRecoverLocalRun: (run: LocalRun) => void
  onExportLocalRunDiagnostics: (run: LocalRun) => void
  onExportLocalData: () => void
  onImportLocalData: (file?: File) => void
}) {
  const importInputRef = useRef<HTMLInputElement>(null)

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">简</span>
        <div>
          <strong>简单 Jiandan</strong>
          <small>AI, simplified.</small>
        </div>
      </div>

      <Button className="primary-action" onClick={onNewConversation}>
        <Plus size={18} />
        新对话
      </Button>

      <div className="conversation-list">
        {conversations.map((conversation) => (
          <Button
            className={conversation.id === activeID ? 'conversation active' : 'conversation'}
            variant="ghost"
            key={conversation.id}
            onClick={() => onSelectConversation(conversation.id)}
          >
            <MessageSquare size={16} />
            <span>{conversation.title}</span>
          </Button>
        ))}
      </div>

      <section className="sidebar-section">
        <div className="section-heading">
          <span>附件资料</span>
          <small>{documents.length} 个</small>
        </div>
        <label className="document-upload">
          <Upload size={18} />
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

        <div className="document-list">
          {documents.map((document) => (
            <div className={document.id === attachedDocumentID ? 'document-list-item active' : 'document-list-item'} key={document.id}>
              <button className="document-select" onClick={() => onAttachDocument(document.id)}>
                <FileText size={16} />
                <span>{document.original_name}</span>
                <small>{document.status}</small>
              </button>
              <button className="document-delete" title={`删除 ${document.original_name}`} onClick={() => onDeleteDocument(document)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="sidebar-section">
        <div className="section-heading">
          <span>本地工作区</span>
          <small>{localStatusLabel}</small>
        </div>
        <label className="workspace-path-field">
          <span>
            <FolderOpen size={15} />
            本地工作区路径
          </span>
          <div className="workspace-path-row">
            <input
              aria-label="本地工作区路径"
              value={localWorkspacePath}
              placeholder="/Users/you/project"
              onChange={(event) => onWorkspacePathChange(event.target.value)}
            />
            {canPickWorkspace ? (
              <button type="button" onClick={onPickWorkspace}>
                选择
              </button>
            ) : null}
          </div>
        </label>
        <button className="workspace-authorize-button" type="button" onClick={onAuthorizeWorkspace}>
          授权当前路径
        </button>
        <button className="workspace-authorize-button subtle" type="button" onClick={() => onDiagnoseWorkspace()}>
          诊断当前路径
        </button>
        {authorizedWorkspaces.length ? (
          <div className="workspace-authorized-list">
            {authorizedWorkspaces.slice(0, 3).map((workspace) => (
              <div className={workspace.path === localWorkspacePath.trim() ? 'workspace-authorized-item active' : 'workspace-authorized-item'} key={workspace.id}>
                <button type="button" onClick={() => onWorkspacePathChange(workspace.path)}>
                  已授权：{workspace.label}
                </button>
                <button title={`诊断 ${workspace.label}`} type="button" onClick={() => onDiagnoseWorkspace(workspace.path)}>
                  诊断
                </button>
                <button title={`撤销 ${workspace.label}`} type="button" onClick={() => onRevokeWorkspace(workspace)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {localRuns.length ? (
        <section className="sidebar-section">
          <div className="section-heading">
            <span>最近本地任务</span>
            <small>{localRuns.length} 个</small>
          </div>
          <div className="local-run-list">
            {localRuns.slice(0, 4).map((run) => (
              <div className="local-run-item" key={run.id}>
                <button type="button" onClick={() => onRecoverLocalRun(run)} title={`恢复 ${run.goal}`}>
                  <RotateCcw size={13} />
                  <span>{run.goal}</span>
                  <small>{run.status}</small>
                </button>
                <button type="button" title={`导出诊断 ${run.goal}`} onClick={() => onExportLocalRunDiagnostics(run)}>
                  <Download size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="local-actions">
        <button onClick={onExportLocalData}>
          <Download size={16} />
          导出
        </button>
        <button onClick={() => importInputRef.current?.click()}>
          <Upload size={16} />
          导入
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(event) => onImportLocalData(event.currentTarget.files?.[0])}
        />
      </div>
    </aside>
  )
}

const documentAccept =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.docx,.xlsx'
