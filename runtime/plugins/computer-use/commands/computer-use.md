Use direct APIs, files, or MCP tools when available. Use Computer Use only for a desktop UI with no reliable direct integration.

1. Call `status`. If the helper is missing, call `setup`, tell the user to enable Accessibility and Screen Recording for `pi-computer-use.app`, then call `status` again.
2. Call `find_roots`, then `observe_ui` for one exact `@r` root.
3. Keep the returned `stateId`. Use `search_ui`, `expand_ui`, or `inspect_ui` without taking another observation.
4. Call `act_ui` with refs from that state. Batch only dependent steps that need no intermediate inspection.
5. Continue from the successor `stateId`. When an outcome is uncertain, observe again before another mutation.

Never guess coordinates or reuse `@e` refs with a different `stateId`.
