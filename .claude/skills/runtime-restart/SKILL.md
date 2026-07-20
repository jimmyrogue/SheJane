---
name: runtime-restart
description: Hard-restart the local SheJane Runtime when Python changes appear stale.
---

# runtime-restart

Primary stage: P1. The Client connection controller owns the managed Runtime process; P2 must receive a newly authenticated Runtime session after restart.

Run:

```bash
make restart-runtime
```

The script:

1. reports the process bound to port 17371;
2. kills that process by port;
3. starts `shejane-runtime` with an isolated environment and a local pairing token;
4. waits for `/v1/health`;
5. reports the new process and log path.

After it succeeds, refresh Electron with Cmd+R so Client reconnects. Do not source a repository `.env`, inject provider keys, restore a Cloud session, or stop an external Runtime that Client does not own.

