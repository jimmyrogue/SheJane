import { IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { LocalArtifact } from '@/shared/local-host/client'

export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: LocalArtifact | null
  onClose: () => void
}) {
  return (
    <Sheet modal={false} open={Boolean(artifact)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="artifact-preview w-[min(640px,92vw)] overflow-hidden sm:max-w-[640px]" showOverlay={false}>
        <SheetHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle>Artifact: {artifact?.title}</SheetTitle>
              <SheetDescription>{artifact?.tool_name ?? 'local artifact'}</SheetDescription>
            </div>
            <Button className="icon-button light" size="icon-sm" variant="ghost" title="关闭 artifact" onClick={onClose}>
              <IconX size={15} />
            </Button>
          </div>
        </SheetHeader>
        <pre className="mt-4 max-h-[calc(100vh-140px)] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-6">{artifact?.content}</pre>
      </SheetContent>
    </Sheet>
  )
}
