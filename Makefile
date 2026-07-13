# ============================================================================
# SheJane / 石间 — developer & ops command surface.
#
#   make            → grouped help (this is the default goal)
#   make ci         → run everything CI runs, locally
#   make dev-electron / restart-daemon → run / hot-restart the dev stack
#   make release COMPONENT=runtime VERSION=X.Y.Z → push runtime-vX.Y.Z
#
# Targets are grouped with `##@ Section` headers and self-document via the
# `## description` after each name — `make help` parses those. Keep new
# targets annotated so they show up.
# ============================================================================

.DEFAULT_GOAL := help

.PHONY: help \
	dev dev-electron restart-daemon doctor \
	test test-e2e test-contract ci test-ci build \
	client-test runtime-client-test local-host-test \
	client-build runtime-client-build local-host-build \
	lint schemas setup-hooks \
	release smoke-local-host \
	eval \
	logs-local-host logs-client logs-dev

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_.-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)
	@echo ""

##@ Dev & restart
dev: ## Print the manual Runtime + Desktop recipe
	@echo "Run Runtime and Desktop in separate terminals:"
	@echo "  cd services/runtime && uv run shejane-runtime"
	@echo "  pnpm --filter @shejane/desktop dev"

dev-electron: ## Runtime + Vite + Electron (hard-restarts; no Cloud required)
	./scripts/dev-electron.sh

restart-daemon: ## Hot-restart ONLY the Python daemon (:17371) after a code edit — seconds, not a full relaunch
	./scripts/restart-daemon.sh

doctor: ## One-shot diagnostic: "why isn't dev working?"
	@./scripts/doctor.sh

##@ Test
test: client-test runtime-client-test local-host-test ## Fast unit suites

test-e2e: ## Playwright simulated E2E (boots isolated Desktop + Runtime route mocks)
	pnpm --filter shejane-e2e test

test-contract: ## Client ↔ daemon contract round-trip over real HTTP (boots a daemon on :17399)
	./scripts/test-contract.sh

ci: lint test build test-e2e test-contract ## Run EVERYTHING CI runs, locally (before pushing a PR)

# Back-compat alias — older docs/muscle-memory call `make test-ci`.
test-ci: ci ## Alias of `ci` (kept for back-compat)

build: ## Build Runtime SDK, Desktop, and Runtime dependencies
	pnpm --filter @shejane/runtime-client build
	pnpm --filter @shejane/desktop build
	cd services/runtime && uv sync

client-test: ## Client vitest (run once)
	pnpm --filter @shejane/desktop test --run

runtime-client-test: ## Runtime TypeScript SDK tests
	pnpm --filter @shejane/runtime-client test

local-host-test: ## Daemon pytest
	cd services/runtime && uv run python -m pytest

client-build: ## Build only the client
	pnpm --filter @shejane/desktop build

runtime-client-build: ## Build the public Runtime TypeScript SDK
	pnpm --filter @shejane/runtime-client build

local-host-build: ## Sync only the daemon deps
	cd services/runtime && uv sync

build-daemon: ## Freeze the Runtime into a standalone bundle for the desktop app (PyInstaller onedir → services/runtime/dist/shejane-runtime/)
	cd services/runtime && uv run pyinstaller shejane-runtime.spec --noconfirm --clean
	@echo "✅ Runtime frozen → services/runtime/dist/shejane-runtime/ (run it on THIS OS/arch only)"

##@ Lint & schemas
lint: ## Run the same lint checks CI runs (ruff + no-platform-keys)
	@echo "→ ruff (Python)"
	@cd services/runtime && uv run ruff check . && uv run ruff format --check .
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

##@ Release
release: ## Cut one module release: COMPONENT=runtime VERSION=X.Y.Z
	@case "$(COMPONENT)" in runtime|desktop|runtime-client) ;; *) echo "❌ COMPONENT must be runtime, desktop, or runtime-client" >&2; exit 1 ;; esac
	@case "$(VERSION)" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "❌ VERSION must look like X.Y.Z" >&2; exit 1 ;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "❌ Working tree not clean — commit or stash first." >&2; exit 1; fi
	@branch=$$(git rev-parse --abbrev-ref HEAD); if [ "$$branch" != "main" ]; then echo "❌ Releases must be cut from main (currently on '$$branch')." >&2; exit 1; fi
	git tag -a "$(COMPONENT)-v$(VERSION)" -m "$(COMPONENT) v$(VERSION)"
	git push origin "$(COMPONENT)-v$(VERSION)"
	@echo "✅ Pushed $(COMPONENT)-v$(VERSION). Only that module's release workflow will run."
##@ Smoke
smoke-local-host: ## Standalone daemon HTTP smoke (health / auth / a deterministic run)
	./scripts/smoke-local-host.sh

eval: ## Run the agent eval suite against a Runtime with a real provider
	cd services/runtime && uv run python -m local_host.eval

##@ Logs
logs-local-host: ## Tail the daemon log (.tmp/dev/local-host.log)
	./scripts/dev-logs.sh local-host

logs-client: ## Tail the client Vite log
	./scripts/dev-logs.sh client

logs-dev: ## Snapshot of all dev logs at once
	./scripts/dev-logs.sh all
