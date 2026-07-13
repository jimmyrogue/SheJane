---
name: sync-schemas
description: Regenerate the daemon→client OpenAPI schema pipeline after editing pydantic models. Runs make schemas, surfaces the resulting diff in openapi.json + generated.d.ts, flags broken downstream usages. Auto-invoke after edits to services/runtime/local_host/api_schemas.py or any handler signature that adds/changes response_model.
user-invocable: false
---

# sync-schemas

The daemon's pydantic models are the single source of truth. `make schemas` regenerates `client/src/shared/local-host/openapi.json` and `client/src/shared/local-host/generated.d.ts` from them. CI's lint job rejects PRs where the committed files drift from regenerated output.

## When to invoke

You just edited one of:

- `services/runtime/local_host/api_schemas.py` (add field, rename, change type, new model)
- `services/runtime/local_host/server.py` where you added `response_model=...` or changed a handler's typed request body
- Anything that affects what FastAPI's `app.openapi()` produces

If you only edited business logic without touching schemas or signatures, **don't** invoke this — `make schemas` is idempotent but takes a few seconds and the diff is noise.

## What to do

```bash
make schemas
```

That runs `scripts/export-daemon-openapi.sh` (dumps `openapi.json`) then `npx openapi-typescript` (regenerates `generated.d.ts`).

Then check:

```bash
git status -- client/src/shared/local-host/openapi.json client/src/shared/local-host/generated.d.ts
git diff --stat -- client/src/shared/local-host/openapi.json client/src/shared/local-host/generated.d.ts
```

## Report back

Tell the user:

1. **Did the schema actually change?** If `git status` shows no diff in the generated files, the pydantic edit was schema-equivalent (renamed a private field, added a default, etc.) — note this and move on.

2. **What changed in the wire shape?** Read the diff and translate to plain English: "added optional `canceled_at: string` to `LocalRun`", "changed `reason` enum from 3 to 4 values", "new endpoint `POST /local/v1/skills/install` surfaces".

3. **Any TypeScript callers broken?** Run `cd client && npx tsc -b --noEmit 2>&1 | head -20`. If a field rename / type narrowing broke a consumer, point to the line.

4. **Reminder to commit**: both `openapi.json` and `generated.d.ts` need to be staged alongside the pydantic change. The CI drift check fails the PR otherwise.

## Don't

- Don't regenerate if `services/runtime/.venv` isn't synced — pydantic version mismatch produces bad `additionalProperties: True` outputs. Run `cd services/runtime && uv sync` first if `Settings()` import fails.
- Don't manually edit `generated.d.ts` or `openapi.json`. They're build artifacts.
- Don't skip the tsc check — schema changes that look benign at the JSON level (e.g. tightening a union) frequently break TS consumers.
