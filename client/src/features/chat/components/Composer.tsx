import { FileText, FolderOpen, Loader2, Send, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { UserDocument } from '@/shared/api/client'
import type { ChatMode } from '@/shared/local-data/types'

export function Composer({
  mode,
  onModeChange,
  draft,
  onDraftChange,
  isSending,
  attachedDocument,
  localProject,
  onDetachDocument,
  onClearLocalProject,
  onSend,
}: {
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  attachedDocument?: UserDocument
  localProject?: {
    label: string
    path: string
    authorized: boolean
  }
  onDetachDocument: () => void
  onClearLocalProject: () => void
  onSend: () => void
}) {
  return (
    <footer className="composer">
      <div className="composer-controls">
        <ModeToggle mode={mode} onChange={onModeChange} />
        <span className="muted">上传和解析免费；发送问题会消耗额度。</span>
      </div>
      {attachedDocument ? (
        <div className={`attachment-chip ${attachedDocument.status !== 'ready' ? 'pending' : ''}`}>
          {attachedDocument.status !== 'ready' && attachedDocument.status !== 'failed' ? <Loader2 size={15} /> : <FileText size={15} />}
          <span>已附加 {attachedDocument.original_name}</span>
          <small>
            {formatBytes(attachedDocument.size_bytes)} · {attachedDocument.status} · {formatDate(attachedDocument.expires_at)}
          </small>
          <Button size="icon-xs" variant="ghost" title="移除附件" onClick={onDetachDocument}>
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {attachedDocument?.status === 'failed' ? (
        <div className="document-status failed">{attachedDocument.error_message || '解析失败'}</div>
      ) : null}
      {!attachedDocument && localProject ? (
        <div className={`local-project-chip ${localProject.authorized ? '' : 'pending'}`}>
          <FolderOpen size={15} />
          <span>本地项目：{localProject.label}</span>
          <small>{localProject.authorized ? '已授权' : '待授权'} · {localProject.path}</small>
          <Button size="icon-xs" variant="ghost" title="移除本地项目引用" onClick={onClearLocalProject}>
            <X size={14} />
          </Button>
        </div>
      ) : null}
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
        <Button className="send-button" disabled={isSending || !draft.trim()} onClick={onSend}>
          <Send size={18} />
          发送
        </Button>
      </div>
    </footer>
  )
}

function ModeToggle({ mode, onChange }: { mode: ChatMode; onChange: (mode: ChatMode) => void }) {
  return (
    <div className="segmented">
      <Button variant={mode === 'fast' ? 'default' : 'outline'} size="sm" onClick={() => onChange('fast')}>
        快速
      </Button>
      <Button variant={mode === 'deep' ? 'default' : 'outline'} size="sm" onClick={() => onChange('deep')}>
        深度
      </Button>
      <Badge variant="secondary">Agentic Chat</Badge>
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
