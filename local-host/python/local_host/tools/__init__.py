"""Tool layer: collects all `BaseTool` instances bound into create_agent.

Composition (final):
- trivial:  time.now, environment.observe, open.url, open.file,
            clipboard.read, clipboard.write
- custom:   workspace.open, task.verify, skill.use, web.fetch,
            image.generate, image.edit
- toolkit:  fs.list/read/write (FileManagementToolkit),
            web.search (langchain-tavily.TavilySearch)
- via middleware (added on the create_agent side, not in this list):
            shell.run (ShellToolMiddleware),
            fs.search Glob+Grep (FilesystemFileSearchMiddleware)
- agentic:  browser (browser-use)
- mcp:      whatever stdio/HTTP MCP servers are configured
"""
