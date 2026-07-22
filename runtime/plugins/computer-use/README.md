# Computer Use plugin

First-party macOS host adapter based on [`injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use), pinned to commit `9f59ed0eeac09b115897732c46b794ee8ca4e5b0` (upstream package version `0.5.0`, MIT).

The plugin keeps upstream UI state in one Runtime-owned Node service for the Run. Plugin Actions still pass through SheJane's P10 validation, permission review, durable receipt, timeout, and cancellation path. Runtime code allowlists this plugin's exact identity, version, handler, and canonical digest, so edited package payload cannot become arbitrary host code.

Build on macOS:

```bash
python runtime/plugins/computer-use/build_package.py \
  --platform darwin/arm64 \
  --upstream /path/to/pi-computer-use-at-9f59ed0 \
  --output /tmp/computer-use-0.1.0-darwin-arm64.shejane-plugin
```

Install the resulting archive from SheJane's Plugins page and enable it. The first `setup` action installs the pinned helper at `~/Applications/pi-computer-use.app`; macOS then requires the user to enable Accessibility and Screen Recording for that helper.

The first release exposes desktop tools only. Upstream CDP browser actions are intentionally omitted because SheJane already owns browser/MCP integration separately.
