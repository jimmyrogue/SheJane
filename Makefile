# ============================================================================
# SheJane / 石间 — developer & ops command surface.
#
#   make            → grouped help (this is the default goal)
#   make ci         → run everything CI runs, locally
#   make dev-electron / restart-daemon → run / hot-restart the dev stack
#   make release COMPONENT=runtime VERSION=X.Y.Z → push runtime-vX.Y.Z
#   make deploy     → pull prebuilt images + (re)start the prod stack
#
# Targets are grouped with `##@ Section` headers and self-document via the
# `## description` after each name — `make help` parses those. Keep new
# targets annotated so they show up.
# ============================================================================

.DEFAULT_GOAL := help

.PHONY: help \
	dev dev-electron dev-fresh dev-nuke restart-daemon doctor docker-up docker-down \
	test test-race test-e2e test-contract ci test-ci build \
	api-test client-test admin-test runtime-client-test local-host-test \
	client-build admin-build runtime-client-build local-host-build \
	lint schemas setup-hooks \
	release deploy deploy-pull deploy-down deploy-logs migrate \
	backup deploy-backup deploy-restore backup-cron-install \
	smoke-local-host smoke-docker-local smoke-real-llm smoke-stripe-webhook smoke-s3-document smoke-external \
	eval \
	logs-api logs-local-host logs-client logs-llm-errors logs-dev

# docker compose invocation for the production stack (pulls prebuilt
# GHCR images — see infra/cloud/docker-compose.prod.yml). Pin Cloud and Admin
# independently with CLOUD_IMAGE_VERSION and ADMIN_IMAGE_VERSION.
COMPOSE_DEV ?= docker compose -f infra/cloud/docker-compose.yml
COMPOSE_PROD ?= docker compose -f infra/cloud/docker-compose.prod.yml

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_.-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)
	@echo ""

##@ Dev & restart
dev: ## Print the manual 3-terminal dev recipe (prefer `make dev-electron`)
	@echo "Run API, client, and admin in three terminals:"
	@echo "  cd services/cloud && HTTP_ADDR=:8080 go run ./cmd/api"
	@echo "  pnpm --filter @shejane/desktop dev"
	@echo "  pnpm --filter shejane-admin dev"

dev-electron: ## Full dev stack: Docker + daemon + Vite + Electron (hard-restarts)
	./scripts/dev-electron.sh

dev-fresh: ## Like dev-electron but `docker compose up -d --build` (rebuild WITH cache)
	./scripts/dev-fresh.sh

dev-nuke: ## Scorched earth: down --remove-orphans + build --no-cache + force-recreate (keeps DB volumes)
	./scripts/dev-nuke.sh

restart-daemon: ## Hot-restart ONLY the Python daemon (:17371) after a code edit — seconds, not a full relaunch
	./scripts/restart-daemon.sh

doctor: ## One-shot diagnostic: "why isn't dev working?"
	@./scripts/doctor.sh

docker-up: ## Bring up the dev Docker stack (build + foreground)
	$(COMPOSE_DEV) up --build

docker-down: ## Stop the dev Docker stack
	$(COMPOSE_DEV) down

##@ Test
test: api-test client-test admin-test runtime-client-test local-host-test ## Fast unit suites

test-race: ## Go tests with the race detector (guards the credit ledger's concurrency)
	cd services/cloud && go test -race ./...

test-e2e: ## Playwright simulated E2E (boots isolated apps/desktop/admin vite + route mocks)
	pnpm --filter shejane-e2e test

test-contract: ## Client ↔ daemon contract round-trip over real HTTP (boots a daemon on :17399)
	./scripts/test-contract.sh

ci: lint test test-race build test-e2e test-contract ## Run EVERYTHING CI runs, locally (before pushing a PR)

# Back-compat alias — older docs/muscle-memory call `make test-ci`.
test-ci: ci ## Alias of `ci` (kept for back-compat)

build: ## Build Cloud, Runtime SDK, Desktop, Admin, and Runtime dependencies
	cd services/cloud && go build ./cmd/api
	pnpm --filter @shejane/runtime-client build
	pnpm --filter @shejane/desktop build
	pnpm --filter shejane-admin build
	cd services/runtime && uv sync

api-test: ## Go unit tests
	cd services/cloud && go test ./...

client-test: ## Client vitest (run once)
	pnpm --filter @shejane/desktop test --run

admin-test: ## Admin vitest (run once)
	pnpm --filter shejane-admin test --run

runtime-client-test: ## Runtime TypeScript SDK tests
	pnpm --filter @shejane/runtime-client test

local-host-test: ## Daemon pytest
	cd services/runtime && uv run python -m pytest

client-build: ## Build only the client
	pnpm --filter @shejane/desktop build

admin-build: ## Build only the admin
	pnpm --filter shejane-admin build

runtime-client-build: ## Build the public Runtime TypeScript SDK
	pnpm --filter @shejane/runtime-client build

local-host-build: ## Sync only the daemon deps
	cd services/runtime && uv sync

build-daemon: ## Freeze the Runtime into a standalone bundle for the desktop app (PyInstaller onedir → services/runtime/dist/shejane-runtime/)
	cd services/runtime && uv run pyinstaller shejane-runtime.spec --noconfirm --clean
	@echo "✅ Runtime frozen → services/runtime/dist/shejane-runtime/ (run it on THIS OS/arch only)"

##@ Lint & schemas
lint: ## Run the same lint checks CI runs (ruff + gofmt + go vet + no-platform-keys)
	@echo "→ ruff (Python)"
	@cd services/runtime && uv run ruff check . && uv run ruff format --check .
	@echo "→ gofmt + go vet (Go)"
	@cd services/cloud && test -z "$$(gofmt -l .)" && go vet ./...
	@echo "→ no-platform-keys guard"
	@./scripts/check-no-platform-keys-in-daemon.sh
	@echo "→ independent release tags"
	@node ./scripts/check-release-tags.mjs
	@echo "✅ all lints pass"

schemas: ## Regenerate openapi.json + generated.ts from the daemon's pydantic models
	@./scripts/export-daemon-openapi.sh
	@pnpm --filter @shejane/runtime-client generate
	@echo "✅ schemas regenerated. Commit openapi.json + generated.ts."

setup-hooks: ## Install lefthook + wire pre-commit hooks (run once per clone)
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

##@ Deploy & release (production)
release: ## Cut one module release: COMPONENT=runtime VERSION=X.Y.Z
	@case "$(COMPONENT)" in runtime|desktop|cloud|admin|runtime-client) ;; *) echo "❌ COMPONENT must be runtime, desktop, cloud, admin, or runtime-client" >&2; exit 1 ;; esac
	@case "$(VERSION)" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "❌ VERSION must look like X.Y.Z" >&2; exit 1 ;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "❌ Working tree not clean — commit or stash first." >&2; exit 1; fi
	@branch=$$(git rev-parse --abbrev-ref HEAD); if [ "$$branch" != "main" ]; then echo "❌ Releases must be cut from main (currently on '$$branch')." >&2; exit 1; fi
	git tag -a "$(COMPONENT)-v$(VERSION)" -m "$(COMPONENT) v$(VERSION)"
	git push origin "$(COMPONENT)-v$(VERSION)"
	@echo "✅ Pushed $(COMPONENT)-v$(VERSION). Only that module's release workflow will run."

deploy: ## Pull independently versioned Cloud/Admin images and restart
	$(COMPOSE_PROD) pull
	$(COMPOSE_PROD) up -d
	@echo "✅ Deployed Cloud=$${CLOUD_IMAGE_VERSION:-latest} Admin=$${ADMIN_IMAGE_VERSION:-latest}."

deploy-pull: ## Pull the latest prod images without restarting
	$(COMPOSE_PROD) pull

deploy-down: ## Stop the prod stack (keeps named volumes / data)
	$(COMPOSE_PROD) down

deploy-logs: ## Tail the prod stack logs
	$(COMPOSE_PROD) logs -f

backup deploy-backup: ## Dump prod Postgres OUTSIDE the repo + copy off-site to S3 (scripts/backup-db.sh)
	./scripts/backup-db.sh

backup-cron-install: ## Install a daily 03:00 cron entry that runs the backup script
	@line="0 3 * * * cd $(CURDIR) && ./scripts/backup-db.sh >> $$HOME/shejane-backup.log 2>&1"; \
	( crontab -l 2>/dev/null | grep -v 'scripts/backup-db.sh' || true; echo "$$line" ) | crontab -; \
	echo "✅ Installed daily backup cron (03:00). Current entries:"; crontab -l | grep 'backup-db.sh'

deploy-restore: ## DANGER: overwrite prod Postgres from BACKUP=<file.sql.gz>
	@test -n "$$BACKUP" || { echo "Usage: make deploy-restore BACKUP=backup-YYYYMMDD-HHMMSS.sql.gz"; exit 1; }
	@test -f "$$BACKUP" || { echo "No such file: $$BACKUP"; exit 1; }
	@printf '⚠️  This OVERWRITES the prod database from %s. Type yes to continue: ' "$$BACKUP"; \
	read ok; [ "$$ok" = "yes" ] || { echo "aborted"; exit 1; }
	@gunzip -c "$$BACKUP" | $(COMPOSE_PROD) exec -T postgres psql -v ON_ERROR_STOP=1 -U shejane -d shejane >/dev/null
	@echo "✅ Restored from $$BACKUP"

migrate: ## Apply pending SQL migrations against DATABASE_URL and record schema_migrations
	cd services/cloud && go run ./cmd/migrate -dir ./migrations

##@ Smoke (opt-in; some hit real services)
smoke-local-host: ## Standalone daemon HTTP smoke (health / auth / a deterministic run)
	./scripts/smoke-local-host.sh

smoke-docker-local: ## Full Docker stack smoke on disposable ports (MOCK_LLM=true)
	./scripts/smoke-docker-local.sh

smoke-real-llm: ## Real LLM provider smoke (needs MOCK_LLM=false + a real key)
	./scripts/smoke-real-llm.sh

eval: ## Run the agent eval suite vs a RUNNING daemon (needs MOCK_LLM=false + SHEJANE_EVAL_TOKEN)
	cd services/runtime && uv run python -m local_host.eval

smoke-stripe-webhook: ## Synthesize a Stripe webhook + verify one-time top-up credit grant
	./scripts/smoke-stripe-webhook.sh

smoke-s3-document: ## Presigned upload to real S3 + best-effort cleanup
	./scripts/smoke-s3-document.sh

smoke-external: ## Chain the real-service smokes (RUN_EXTERNAL_SMOKE=1 required)
	./scripts/smoke-external.sh

##@ Logs
logs-api: ## Tail the API (docker compose) logs
	./scripts/dev-logs.sh api

logs-local-host: ## Tail the daemon log (.tmp/dev/local-host.log)
	./scripts/dev-logs.sh local-host

logs-client: ## Tail the client Vite log
	./scripts/dev-logs.sh client

logs-llm-errors: ## Query the llm_call_records table for recent failures
	./scripts/dev-logs.sh llm-errors

logs-dev: ## Snapshot of all dev logs at once
	./scripts/dev-logs.sh all
