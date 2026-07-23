"""Tool layer: collects all `BaseTool` instances bound into create_agent.

Composition (final):
- trivial:  time.now, environment.observe, open.url, open.file,
            clipboard.read, clipboard.write
- custom:   task.verify, task.progress, skill.use, web.fetch
- via middleware (added on the create_agent side, not in this list):
            deepagents filesystem/shell tools (ls/read_file/write_file/
            edit_file/glob/grep/execute)
- browser:  fixed Browser QA plugin Actions, bound per Run by Runtime
- mcp:      whatever stdio/HTTP MCP servers are configured
"""
