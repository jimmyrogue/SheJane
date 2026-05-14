import { IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useI18n } from '@/shared/i18n/i18n'
import type { LocalArtifact } from '@/shared/local-host/client'

export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: LocalArtifact | null
  onClose: () => void
}) {
  const { t } = useI18n()

  return (
    <Sheet modal={false} open={Boolean(artifact)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="artifact-preview w-[min(640px,92vw)] overflow-hidden sm:max-w-[640px]" showOverlay={false}>
        <SheetHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle>{t('artifact.title', { title: artifact?.title })}</SheetTitle>
              <SheetDescription>{artifact?.tool_name ?? t('artifact.defaultTool')}</SheetDescription>
            </div>
            <Button className="icon-button light" size="icon-sm" variant="ghost" title={t('artifact.close')} onClick={onClose}>
              <IconX size={15} />
            </Button>
          </div>
        </SheetHeader>
        <pre className="mt-4 max-h-[calc(100vh-140px)] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-6">{artifact?.content}</pre>
      </SheetContent>
    </Sheet>
  )
}
