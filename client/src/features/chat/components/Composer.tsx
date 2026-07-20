import {
  IconArrowUp,
  IconFolder,
  IconFolderPlus,
  IconFile,
  IconPaperclip,
  IconPlayerStopFilled,
  IconShield,
  IconX,
} from '@tabler/icons-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ModeSelector, type ModelOption } from './ModeSelector'
import { SkillEditor } from './SkillEditor'
import { useI18n } from '@/shared/i18n/i18n'
import type {
  InstalledSkill,
  McpServerInfo,
  PermissionMode,
  PluginDetail,
} from '@/runtime/client'
import type { ChatMode, LocalAttachmentRef } from '@/shared/local-data/types'

export function Composer({
  draft,
  onDraftChange,
  isSending,
  hasActiveRun = false,
  onSend,
  onAppendInstruction,
  onStop,
  listSkills,
  listMcpServers,
  listPlugins,
  mode,
  models = [],
  onModeChange,
  permissionMode = 'auto',
  onPermissionModeChange,
  onConfigureModels,
  projectName,
  onSelectProject,
  onRemoveProject,
  attachments = [],
  onSelectAttachments,
  onRemoveAttachment,
  isDesktop = true,
  slashCommandsEnabled = true,
}: {
  draft: string
  onDraftChange: (value: string) => void
  isSending: boolean
  /** Runtime runs remain cancelable while paused for permission or input. */
  hasActiveRun?: boolean
  onSend: () => void
  /** Append a user instruction into the currently active Runtime run. */
  onAppendInstruction?: () => void
  onStop?: () => void
  listSkills: () => Promise<InstalledSkill[]>
  listMcpServers?: () => Promise<McpServerInfo[]>
  listPlugins?: () => Promise<PluginDetail[]>
  mode: ChatMode
  models?: ModelOption[]
  onModeChange: (mode: ChatMode) => void
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  onConfigureModels?: () => void
  projectName?: string
  onSelectProject?: () => void
  onRemoveProject?: () => void
  attachments?: LocalAttachmentRef[]
  onSelectAttachments?: () => void
  onRemoveAttachment?: (path: string) => void
  isDesktop?: boolean
  slashCommandsEnabled?: boolean
}) {
  const { t } = useI18n()
  const canStop = (isSending || hasActiveRun) && Boolean(onStop)
  const steeringMode = hasActiveRun && Boolean(onAppendInstruction)
  const sendLabel = steeringMode ? t('composer.appendInstruction') : t('composer.send')
  const sendTitle = steeringMode ? t('composer.appendInstruction') : t('composer.kbdHint')
  const handleSend = steeringMode ? onAppendInstruction : onSend

  return (
    <footer className="composer">
      <div className="composer-input">
        {attachments.length ? (
          <div className="composer-chips">
            {attachments.map((attachment) => (
              <span className="composer-attachment-chip" key={attachment.path} title={attachment.path}>
                <IconFile size={14} aria-hidden="true" />
                <span>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={t('composer.attachment.remove', { name: attachment.name })}
                  disabled={!onRemoveAttachment || isSending || hasActiveRun}
                  onClick={() => onRemoveAttachment?.(attachment.path)}
                >
                  <IconX size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <SkillEditor
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={() => handleSend?.()}
          listSkills={listSkills}
          listMcpServers={listMcpServers}
          listPlugins={listPlugins}
          commandsEnabled={slashCommandsEnabled}
          pluginReferencesEnabled={!steeringMode}
          placeholder={steeringMode ? t('composer.steeringPlaceholder') : t('composer.placeholder')}
        />
        {steeringMode ? (
          <p className="composer-plugin-run-note">{t('composer.pluginMenu.newRunRequired')}</p>
        ) : null}
      </div>

      <div className="composer-toolbar">
        {isDesktop ? (
          <button
            type="button"
            className="composer-tool"
            aria-label={t('composer.attachment.add')}
            title={t('composer.attachment.tooltip')}
            disabled={!onSelectAttachments || isSending || hasActiveRun}
            onClick={() => onSelectAttachments?.()}
          >
            <IconPaperclip size={16} aria-hidden="true" />
          </button>
        ) : null}
        {!isDesktop ? null : projectName ? (
          <span
            className="composer-project-chip"
            title={t('composer.projectPicker.selected', { name: projectName })}
          >
            <button
              type="button"
              className="composer-project-select"
              aria-label={t('composer.projectPicker.replace', { name: projectName })}
              title={t('composer.projectPicker.replace', { name: projectName })}
              disabled={!onSelectProject || isSending || hasActiveRun}
              onClick={() => onSelectProject?.()}
            >
              <IconFolder size={14} aria-hidden="true" />
              <span className="composer-project-chip-name">{projectName}</span>
            </button>
            <button
              type="button"
              className="composer-project-remove"
              aria-label={t('composer.projectPicker.remove', { name: projectName })}
              title={t('composer.projectPicker.remove', { name: projectName })}
              disabled={!onRemoveProject || isSending || hasActiveRun}
              onClick={() => onRemoveProject?.()}
            >
              <IconX size={12} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="composer-tool composer-project-button"
            aria-label={t('composer.projectPicker.add')}
            title={t('composer.projectPicker.tooltip')}
            disabled={!onSelectProject || isSending || steeringMode}
            onClick={() => onSelectProject?.()}
          >
            <IconFolderPlus size={16} aria-hidden="true" />
          </button>
        )}

        <PermissionModeSelector
          mode={permissionMode}
          onChange={onPermissionModeChange}
          disabled={isSending || hasActiveRun}
        />

        <ModeSelector
          mode={mode}
          models={models}
          onChange={onModeChange}
          onConfigureModels={onConfigureModels}
          disabled={isSending || steeringMode}
        />

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
        ) : null}

        {!canStop || steeringMode ? (
          <button
            type="button"
            className="composer-send"
            aria-label={sendLabel}
            disabled={steeringMode ? !draft.trim() : isSending || !draft.trim()}
            title={sendTitle}
            onClick={() => handleSend?.()}
          >
            <IconArrowUp size={16} aria-hidden="true" />
            <span className="sr-only">{sendLabel}</span>
          </button>
        ) : null}
      </div>
    </footer>
  )
}

function PermissionModeSelector({
  mode,
  onChange,
  disabled,
}: {
  mode: PermissionMode
  onChange?: (mode: PermissionMode) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const modes: PermissionMode[] = ['ask', 'auto', 'full_access']
  const label = t(`composer.permission.${mode}.label`)

  const select = (next: PermissionMode) => {
    if (next === 'full_access' && !window.confirm(t('composer.permission.fullAccessConfirm'))) {
      return
    }
    onChange?.(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || !onChange}>
        <button
          type="button"
          className={`composer-permission-trigger${mode === 'full_access' ? ' is-full-access' : ''}`}
          aria-label={t('composer.permission.menuLabel', { mode: label })}
          title={label}
          disabled={disabled || !onChange}
        >
          <IconShield size={15} aria-hidden="true" />
          <span>{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="composer-permission-menu">
        {modes.map((item) => (
          <DropdownMenuItem
            key={item}
            className="composer-permission-item"
            onSelect={() => select(item)}
          >
            <span>
              <strong>{t(`composer.permission.${item}.label`)}</strong>
              <small>{t(`composer.permission.${item}.description`)}</small>
            </span>
            {item === mode ? <span aria-hidden="true">✓</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
