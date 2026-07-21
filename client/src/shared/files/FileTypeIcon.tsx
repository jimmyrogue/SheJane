import {
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconPhoto,
} from '@tabler/icons-react'

import { filePreviewKind } from './filePreview'

export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const props = { 'aria-hidden': true, size, stroke: 1.6 }
  switch (filePreviewKind(name)) {
    case 'word': return <IconFileTypeDocx {...props} />
    case 'excel': return <IconFileTypeXls {...props} />
    case 'powerpoint': return <IconFileTypePpt {...props} />
    case 'pdf': return <IconFileTypePdf {...props} />
    case 'code': return <IconFileCode {...props} />
    case 'text': return <IconFileText {...props} />
    case 'image': return <IconPhoto {...props} />
    default: return <IconFile {...props} />
  }
}
