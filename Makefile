.PHONY: test test-ci test-e2e build api-test client-test admin-test local-host-test client-build admin-build local-host-build dev dev-electron dev-fresh dev-nuke docker-up docker-down migrate logs-api logs-local-host logs-client logs-llm-errors logs-dev smoke-local-host smoke-agent-research smoke-docker-local smoke-real-llm smoke-stripe-webhook smoke-s3-document smoke-external doctor setup-hooks lint schemas

test: api-test client-test admin-test local-host-test

test-ci: test build test-e2e

test-e2e:
	cd e2e && npm test

build:
	cd api && go build ./cmd/api
	cd client && npm run build
	cd admin && npm run build
	cd local-host/python && uv sync

api-test:
	cd api && go test ./...

client-test:
	cd client && npm test -- --run

admin-test:
	cd admin && npm test -- --run

local-host-test:
	cd local-host/python && uv run pytest

client-build:
	cd client && npm run build

admin-build:
	cd admin && npm run build

local-host-build:
	cd local-host/python && uv sync

dev:
	@echo "Run API, client, and admin in three terminals:"
	@echo "  cd api && HTTP_ADDR=:8080 go run ./cmd/api"
	@echo "  cd client && npm run dev"
	@echo "  cd admin && npm run dev"

dev-electron:
	./scripts/dev-electron.sh

dev-fresh:
	./scripts/dev-fresh.sh

# Scorched-earth reset: docker compose down --remove-orphans +
# build --no-cache + up --force-recreate, then relaunch native.
# Use when dev-fresh isn't enough — poisoned build cache (stale
# image despite --build) or a wedged container. Keeps DB volumes;
# for an empty DB run `docker compose down -v` first.
dev-nuke:
	./scripts/dev-nuke.sh

docker-up:
	docker compose up --build

docker-down:
	docker compose down

migrate:
	@set -e; for file in api/migrations/*.sql; do psql -v ON_ERROR_STOP=1 "$$DATABASE_URL" -f "$$file"; done

logs-api:
	./scripts/dev-logs.sh api

logs-local-host:
	./scripts/dev-logs.sh local-host

logs-client:
	./scripts/dev-logs.sh client

logs-llm-errors:
	./scripts/dev-logs.sh llm-errors

logs-dev:
	./scripts/dev-logs.sh all

smoke-local-host:
	./scripts/smoke-local-host.sh

smoke-agent-research:
	@echo "Phase 5'+ TODO: port smoke:research from old Node daemon to Python (Phase 6' research subagent)"

smoke-docker-local:
	./scripts/smoke-docker-local.sh

smoke-real-llm:
	./scripts/smoke-real-llm.sh

smoke-stripe-webhook:
	./scripts/smoke-stripe-webhook.sh

smoke-s3-document:
	./scripts/smoke-s3-document.sh

smoke-external:
	./scripts/smoke-external.sh

# Single-shot dev diagnostic. Prints why dev probably isn't working
# (daemon stragglers / forbidden keys leaked / cloud session unpaired
# / LangSmith key rejected / etc.). See scripts/doctor.sh for what it
# actually checks.
doctor:
	@./scripts/doctor.sh

# Install lefthook + wire pre-commit hooks. Run once per clone.
# Bypass a single commit with LEFTHOOK=0 git commit (e.g. WIP on a
# personal branch). lefthook.yml has the actual check list.
setup-hooks:
	@if ! command -v lefthook >/dev/null 2>&1; then \
		echo "lefthook not found. Installing via brew (macOS)…"; \
		if command -v brew >/dev/null 2>&1; then \
			brew install lefthook; \
		else \
			echo "❌ brew not available. Install lefthook manually:" >&2; \
			echo "    https://github.com/evilmartians/lefthook#install" >&2; \
			exit 1; \
		fi; \
	fi
	@lefthook install
	@echo "✅ Pre-commit hooks wired. Bypass once with: LEFTHOOK=0 git commit"

# Regenerate the daemon → client schema pipeline. Two steps:
#   1. Daemon exports openapi.json via app.openapi() (no server boot).
#   2. openapi-typescript reads it and writes generated.d.ts.
#
# Run this after touching `local_host/api_schemas.py` or any
# `response_model=` annotation; commit both files. CI rejects PRs
# where they drift from what the daemon currently emits.
schemas:
	@./scripts/export-daemon-openapi.sh
	@cd client && npx openapi-typescript src/shared/local-host/openapi.json -o src/shared/local-host/generated.d.ts
	@echo "✅ schemas regenerated. Commit openapi.json + generated.d.ts."

# Run the same lint checks CI runs — useful before pushing a PR.
# Goes beyond `make setup-hooks` (which only runs on staged files);
# this lints the whole repo.
lint:
	@echo "→ ruff (Python)"
	@cd local-host/python && uv run ruff check . && uv run ruff format --check .
	@echo "→ gofmt + go vet (Go)"
	@cd api && test -z "$$(gofmt -l .)" && go vet ./...
	@echo "→ no-platform-keys guard"
	@./scripts/check-no-platform-keys-in-daemon.sh
	@echo "✅ all lints pass"
