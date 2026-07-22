Use direct APIs, files, or MCP tools when available. Use Computer Use only for a desktop UI with no reliable direct integration.

1. Call `find_roots`, then `observe_ui` for one exact `@r` root. Computer Use setup is owned by SheJane's Plugins page; never try to install helpers or open macOS settings from the conversation.
2. Keep the returned `stateId`. Use `search_ui`, `expand_ui`, or `inspect_ui` without taking another observation.
3. Call `act_ui` with refs from that state. Batch only dependent steps that need no intermediate inspection.
4. Continue from the successor `stateId`. When an outcome is uncertain, observe again before another mutation.

Never guess coordinates or reuse `@e` refs with a different `stateId`.
