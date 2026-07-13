-- E2B's "per-sandbox" URLs (where code execution + file IO live) are
-- composed as `https://{port}-{sandboxID}-{clientID}.e2b.dev`. The
-- clientID is returned at sandbox create-time and required to talk to
-- the sandbox across any later call (RunCode, UploadFile, etc.).
-- Without it, daemon restarts would lose the routing component and we
-- couldn't reuse an existing sandbox.
--
-- This is a forward-only ALTER. Existing rows (if any) get an empty
-- default — they'll be treated as stale by the code path (any RunCode
-- against an empty clientID URL returns 404, triggering the existing
-- "sandbox vanished" retry which provisions a fresh one).

ALTER TABLE sandbox_sessions
    ADD COLUMN IF NOT EXISTS e2b_client_id VARCHAR(120) NOT NULL DEFAULT '';
