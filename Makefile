# ============================================================================
# SheJane / 石间 — developer & ops command surface.
#
#   make            → grouped help (this is the default goal)
#   make ci         → run everything CI runs, locally
#   make dev-electron / restart-daemon → run / hot-restart the dev stack
#   make release VERSION=vX.Y.Z → cut a release (CI builds + pushes images)
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
	api-test client-test admin-test local-host-test \
	client-build admin-build local-host-build \
	lint schemas setup-hooks \
	release deploy deploy-pull deploy-down deploy-logs migrate \
	smoke-local-host smoke-docker-local smoke-real-llm smoke-stripe-webhook smoke-s3-document smoke-external \
	logs-api logs-local-host logs-client logs-llm-errors logs-dev

# docker compose invocation for the production stack (pulls prebuilt
# GHCR images — see docker-compose.prod.yml). Override IMAGE_TAG to pin
# a version: `make deploy IMAGE_TAG=v0.3.1`.
COMPOSE_PROD ?= docker compose -f docker-compose.prod.yml

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_.-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)
	@echo ""

##@ Dev & restart
dev: ## Print the manual 3-terminal dev recipe (prefer `make dev-electron`)
	@echo "Run API, client, and admin in three terminals:"
	@echo "  cd api && HTTP_ADDR=:8080 go run ./cmd/api"
	@echo "  cd client && npm run dev"
	@echo "  cd admin && npm run dev"

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
	docker compose up --build

docker-down: ## Stop the dev Docker stack
	docker compose down

##@ Test
test: api-test client-test admin-test local-host-test ## Fast unit suites (Go + client + admin + daemon)

test-race: ## Go tests with the race detector (guards the credit ledger's concurrency)
	cd api && go test -race ./...

test-e2e: ## Playwright simulated E2E (boots isolated client/admin vite + route mocks)
	cd e2e && npm test

test-contract: ## Client ↔ daemon contract round-trip over real HTTP (boots a daemon on :17399)
	./scripts/test-contract.sh

ci: lint test test-race build test-e2e test-contract ## Run EVERYTHING CI runs, locally (before pushing a PR)

# Back-compat alias — older docs/muscle-memory call `make test-ci`.
test-ci: ci ## Alias of `ci` (kept for back-compat)

build: ## Build all four stacks (go binary + client + admin + daemon deps)
	cd api && go build ./cmd/api
	cd client && npm run build
	cd admin && npm run build
	cd local-host/python && uv sync

api-test: ## Go unit tests
	cd api && go test ./...

client-test: ## Client vitest (run once)
	cd client && npm test -- --run

admin-test: ## Admin vitest (run once)
	cd admin && npm test -- --run

local-host-test: ## Daemon pytest
	cd local-host/python && uv run python -m pytest

client-build: ## Build only the client
	cd client && npm run build

admin-build: ## Build only the admin
	cd admin && npm run build

local-host-build: ## Sync only the daemon deps
	cd local-host/python && uv sync

##@ Lint & schemas
lint: ## Run the same lint checks CI runs (ruff + gofmt + go vet + no-platform-keys)
	@echo "→ ruff (Python)"
	@cd local-host/python && uv run ruff check . && uv run ruff format --check .
	@echo "→ gofmt + go vet (Go)"
	@cd api && test -z "$$(gofmt -l .)" && go vet ./...
	@echo "→ no-platform-keys guard"
	@./scripts/check-no-platform-keys-in-daemon.sh
	@echo "✅ all lints pass"

schemas: ## Regenerate openapi.json + generated.d.ts from the daemon's pydantic models
	@./scripts/export-daemon-openapi.sh
	@cd client && npx openapi-typescript src/shared/local-host/openapi.json -o src/shared/local-host/generated.d.ts
	@echo "✅ schemas regenerated. Commit openapi.json + generated.d.ts."

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
release: ## Cut a release: tag + push VERSION=vX.Y.Z (CI builds & pushes images to GHCR)
	@if [ -z "$(VERSION)" ]; then echo "❌ Usage: make release VERSION=vX.Y.Z" >&2; exit 1; fi
	@case "$(VERSION)" in v[0-9]*) ;; *) echo "❌ VERSION must look like vX.Y.Z (got '$(VERSION)')" >&2; exit 1 ;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "❌ Working tree not clean — commit or stash first." >&2; exit 1; fi
	@branch=$$(git rev-parse --abbrev-ref HEAD); if [ "$$branch" != "main" ]; then echo "❌ Releases must be cut from main (currently on '$$branch')." >&2; exit 1; fi
	git tag -a "$(VERSION)" -m "Release $(VERSION)"
	git push origin "$(VERSION)"
	@echo "✅ Pushed tag $(VERSION). The Release workflow now builds + pushes images to GHCR."

deploy: ## Pull prebuilt GHCR images + (re)start the prod stack (IMAGE_TAG=latest)
	$(COMPOSE_PROD) pull
	$(COMPOSE_PROD) up -d
	@echo "✅ Deployed (IMAGE_TAG=$${IMAGE_TAG:-latest}). Logs: make deploy-logs"

deploy-pull: ## Pull the latest prod images without restarting
	$(COMPOSE_PROD) pull

deploy-down: ## Stop the prod stack (keeps named volumes / data)
	$(COMPOSE_PROD) down

deploy-logs: ## Tail the prod stack logs
	$(COMPOSE_PROD) logs -f

migrate: ## Apply SQL migrations against DATABASE_URL (psql, fail-fast)
	@set -e; for file in api/migrations/*.sql; do psql -v ON_ERROR_STOP=1 "$$DATABASE_URL" -f "$$file"; done

##@ Smoke (opt-in; some hit real services)
smoke-local-host: ## Standalone daemon HTTP smoke (health / auth / a deterministic run)
	./scripts/smoke-local-host.sh

smoke-docker-local: ## Full Docker stack smoke on disposable ports (MOCK_LLM=true)
	./scripts/smoke-docker-local.sh

smoke-real-llm: ## Real LLM provider smoke (needs MOCK_LLM=false + a real key)
	./scripts/smoke-real-llm.sh

smoke-stripe-webhook: ## Synthesize a Stripe webhook + verify subscription lifecycle
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
