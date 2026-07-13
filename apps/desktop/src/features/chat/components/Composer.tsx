import {
  IconArrowUp,
  IconFolder,
  IconFolderPlus,
  IconPlayerStopFilled,
} from '@tabler/icons-react'
import { ModeSelector, type ModelOption } from './ModeSelector'
import { SkillEditor } from './SkillEditor'
import { useI18n } from '@/shared/i18n/i18n'
import type { InstalledSkill, McpServerInfo } from '@/shared/local-host/client'
import type { ChatMode } from '@/shared/local-data/types'

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
  mode,
  models = [],
  onModeChange,
  projectName,
  onSelectProject,
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
  mode: ChatMode
  models?: ModelOption[]
  onModeChange: (mode: ChatMode) => void
  projectName?: string
  onSelectProject?: () => void
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
        <SkillEditor
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={() => handleSend?.()}
          listSkills={listSkills}
          listMcpServers={listMcpServers}
          commandsEnabled={slashCommandsEnabled}
          placeholder={steeringMode ? t('composer.steeringPlaceholder') : t('composer.placeholder')}
        />
      </div>

      <div className="composer-toolbar">
        {!isDesktop ? null : projectName ? (
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
            disabled={!onSelectProject || isSending || steeringMode}
            onClick={() => onSelectProject?.()}
          >
            <IconFolderPlus size={16} aria-hidden="true" />
          </button>
        )}

        <ModeSelector
          mode={mode}
          models={models}
          onChange={onModeChange}
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
