"""Tool layer: collects all `BaseTool` instances bound into create_agent.

Composition (final):
- trivial:  time.now, environment.observe, open.url, open.file,
            clipboard.read, clipboard.write
- custom:   task.verify, task.progress, skill.use, web.fetch
- gateway:  image.generate, image.edit, web.search — all proxy through
            POST /api/v1/agent/tools/execute (cloud Tool Gateway). No
            platform-paid provider keys live in the daemon env.
- via middleware (added on the create_agent side, not in this list):
            deepagents filesystem/shell tools (ls/read_file/write_file/
            edit_file/glob/grep/execute)
- agentic:  optional browser.task (browser-use), hidden until configured
- mcp:      whatever stdio/HTTP MCP servers are configured
"""
