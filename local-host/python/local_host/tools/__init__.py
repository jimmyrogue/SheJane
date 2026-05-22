"""Tool layer: collects all `BaseTool` instances bound into create_agent.

Composition (final):
- trivial:  time.now, environment.observe, open.url, open.file,
            clipboard.read, clipboard.write
- custom:   workspace.open, task.verify, skill.use, web.fetch
- gateway:  image.generate, image.edit, web.search — all proxy through
            POST /api/v1/agent/tools/execute (cloud Tool Gateway). No
            platform-paid provider keys live in the daemon env.
- via middleware (added on the create_agent side, not in this list):
            shell.run (ShellToolMiddleware),
            fs.search Glob+Grep (FilesystemFileSearchMiddleware)
- agentic:  browser (browser-use)
- mcp:      whatever stdio/HTTP MCP servers are configured
"""
