---
name: daemon-restart
description: Hard-restart the local-host Python daemon. Kills whatever's on port 17371 (including processes that survived SIGTERM), spawns a fresh process with the right env vars, waits for /local/v1/health to respond, confirms the new code is loaded. Use when dev seems broken in ways that match "is the daemon running old code?"
---

# daemon-restart

**The most common cause of "my Python change didn't take effect"** is a stale daemon process still bound to port 17371 with code loaded into memory from minutes/hours ago. uvicorn traps SIGTERM and can survive `pkill` if the asyncio loop is stuck on an interrupt resume. This skill bypasses all that.

## When to invoke

- "I edited Python but the behavior didn't change after I restarted dev-electron"
- `make dev-electron` reports "Local Host already running at http://127.0.0.1:17371" but you suspect that running process is stale
- `make doctor` shows the daemon's `started` time is older than your last edit to `services/runtime/`
- The Electron app keeps falling back to cloud chat (canUseLocalHarness=false) even though pairing was working earlier
- LangSmith trace shows your latest code path was NOT executed (e.g. you added a new event_translator branch but it's not firing)

## What to do

**Fastest path: `make restart-daemon`.** It runs exactly the steps below —
kill-by-port (not by name), respawn under the `env -i` allowlist (no
platform-paid keys leak in — CLAUDE.md Invariant #1), wait for
`/local/v1/health`, print old/new PID, and remind you to Cmd+R Electron.
Reach for the manual version below only when you need to tweak a step:

```bash
# 1. Find AND kill the actual process bound to 17371, not just the
#    one matching `python -m local_host` (sometimes the process name
#    is rewritten and pkill misses).
lsof -ti :17371 2>/dev/null | xargs -r kill -9
sleep 1
lsof -i :17371 2>/dev/null  # confirm port is free

# 2. Respawn with the full env block dev-electron.sh uses. Doing it
#    in a subshell so the loaded .env vars don't pollute the caller.
(
  set -a; source .env; set +a
  cd services/runtime
  SHEJANE_LOCAL_HOST_TOKEN="${SHEJANE_LOCAL_HOST_TOKEN:-dev-local-token}" \
  SHEJANE_LOCAL_HOST_PORT=17371 \
  SHEJANE_LOCAL_HOST_URL=http://127.0.0.1:17371 \
  SHEJANE_CLOUD_BASE_URL=http://localhost:8080 \
  PYTHONUNBUFFERED=1 \
  nohup uv run python -m local_host > /tmp/local-host.log 2>&1 &
  echo "respawned pid $!"
)

# 3. Wait for health endpoint.
until curl -fsS http://127.0.0.1:17371/local/v1/health >/dev/null 2>&1; do sleep 1; done

# 4. Confirm new code by checking process start time vs latest edit.
NEW_PID=$(lsof -ti :17371 | head -1)
echo "Daemon $NEW_PID started: $(ps -p $NEW_PID -o lstart=)"
ls -la --time=mtime services/runtime/local_host/server.py | awk '{print "server.py last modified:", $6, $7, $8}'
```

## Report back

1. **Old PID + start time** (so the user sees what was wrong — e.g. "PID 18436 was running since 2 hours ago").
2. **New PID + start time** (so the user sees the fix worked).
3. **Tell the user to Cmd+R refresh Electron** — the daemon restart wiped the in-memory `cloud_token`. The renderer needs to re-POST `/local/v1/session` to re-pair. Without this, chat keeps showing 401 from `/api/v1/agent/llm/stream` even though everything looks healthy.

## Don't

- Don't use `pkill -f 'python -m local_host'` alone — we've seen processes survive that. Always use the `lsof -ti :17371 | xargs kill -9` pattern.
- Don't restart from within `make dev-electron`'s child process — that's how stragglers happen in the first place.
- Don't forget to source `.env` — without it the daemon comes up with default values for `LANGSMITH_*` / `SHEJANE_LOCAL_TOOL_CRITIC` / etc., which look "working" but disable observability silently.
- Don't kill the Docker postgres container or the Electron app — they're independent of the daemon.
