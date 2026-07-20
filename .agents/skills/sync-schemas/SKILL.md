---
name: sync-schemas
description: Regenerate the runtime→client OpenAPI schema pipeline after editing pydantic models. Runs make schemas, surfaces the resulting diff in openapi.json + generated.ts, flags broken downstream usages. Auto-invoke after edits to runtime/src/shejane_runtime/api_schemas.py or any handler signature that adds/changes response_model.
user-invocable: false
---

# sync-schemas

The runtime's pydantic models are the single source of truth. `make schemas` regenerates `runtime/sdk/openapi.json` and `runtime/sdk/src/generated.ts` from them. CI's lint job rejects PRs where the committed files drift from regenerated output.

## When to invoke

You just edited one of:

- `runtime/src/shejane_runtime/api_schemas.py` (add field, rename, change type, new model)
- `runtime/src/shejane_runtime/server.py` where you added `response_model=...` or changed a handler's typed request body
- Anything that affects what FastAPI's `app.openapi()` produces

If you only edited business logic without touching schemas or signatures, **don't** invoke this — `make schemas` is idempotent but takes a few seconds and the diff is noise.

## What to do

```bash
make schemas
```

That runs `scripts/export-runtime-openapi.sh` (dumps `openapi.json`) then `npx openapi-typescript` (regenerates `generated.ts`).

Then check:

```bash
git status -- runtime/sdk/openapi.json runtime/sdk/src/generated.ts
git diff --stat -- runtime/sdk/openapi.json runtime/sdk/src/generated.ts
```

## Report back

Tell the user:

1. **Did the schema actually change?** If `git status` shows no diff in the generated files, the pydantic edit was schema-equivalent (renamed a private field, added a default, etc.) — note this and move on.

2. **What changed in the wire shape?** Read the diff and translate to plain English: "added optional `canceled_at: string` to `LocalRun`", "changed `reason` enum from 3 to 4 values", "new endpoint `POST /v1/skills/install` surfaces".

3. **Any TypeScript callers broken?** Run `cd client && pnpm exec tsc -b --noEmit 2>&1 | head -20`. If a field rename / type narrowing broke a consumer, point to the line.

4. **Reminder to commit**: both `openapi.json` and `generated.ts` need to be staged alongside the pydantic change. The CI drift check fails the PR otherwise.

## Don't

- Don't regenerate if `runtime/.venv` isn't synced — pydantic version mismatch produces bad `additionalProperties: True` outputs. Run `cd runtime && uv sync` first if `Settings()` import fails.
- Don't manually edit `generated.ts` or `openapi.json`. They're build artifacts.
- Don't skip the tsc check — schema changes that look benign at the JSON level (e.g. tightening a union) frequently break TS consumers.
