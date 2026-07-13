# @shejane/runtime-sdk

TypeScript SDK for the public SheJane Harness Runtime HTTP and SSE protocols.

```ts
import { SheJaneRuntimeClient } from '@shejane/runtime-sdk'

const runtime = new SheJaneRuntimeClient({
  baseURL: 'http://127.0.0.1:17371',
  token: '<runtime-token>',
})

const info = await runtime.getRuntimeInfo()
```

Electron, React, IndexedDB, and SheJane product UI types are intentionally outside this package. A caller may provide its own authenticated `fetcher` instead of a token.

See [`openapi.json`](./openapi.json) for the complete Runtime protocol.
