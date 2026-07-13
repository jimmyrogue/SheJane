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
	dev-electron restart-daemon doctor \
	test test-contract ci build \
	client-test runtime-sdk-test local-host-test \
	client-build runtime-sdk-build local-host-build \
	lint schemas setup-hooks \
	release eval \
	logs-local-host logs-client logs-dev

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_.-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)
	@echo ""

##@ Dev & restart
dev-electron: ## Runtime + Vite + Electron (hard-restarts; no Cloud required)
	./scripts/dev.sh start

restart-daemon: ## Hot-restart ONLY the Python daemon (:17371) after a code edit — seconds, not a full relaunch
	./scripts/dev.sh restart

doctor: ## One-shot diagnostic: "why isn't dev working?"
	@./scripts/dev.sh doctor

##@ Test
test: client-test runtime-sdk-test local-host-test ## Fast unit suites

test-contract: ## Client ↔ daemon contract round-trip over real HTTP (boots a daemon on :17399)
	./scripts/test-contract.sh

ci: lint test build test-contract ## Run EVERYTHING CI runs, locally (before pushing a PR)

build: ## Build Runtime SDK, Desktop, and Runtime dependencies
	pnpm --filter @shejane/runtime-sdk build
	pnpm --filter @shejane/desktop build
	cd services/runtime && uv sync

client-test: ## Client vitest (run once)
	pnpm --filter @shejane/desktop test --run

runtime-sdk-test: ## Runtime TypeScript SDK tests
	pnpm --filter @shejane/runtime-sdk test

local-host-test: ## Daemon pytest
	cd services/runtime && uv run python -m pytest

client-build: ## Build only the client
	pnpm --filter @shejane/desktop build

runtime-sdk-build: ## Build the public Runtime TypeScript SDK
	pnpm --filter @shejane/runtime-sdk build

local-host-build: ## Sync only the daemon deps
	cd services/runtime && uv sync

build-daemon: ## Freeze the Runtime into a standalone bundle for the desktop app (PyInstaller onedir → services/runtime/dist/shejane-runtime/)
	cd services/runtime && uv run pyinstaller shejane-runtime.spec --noconfirm --clean
	@echo "✅ Runtime frozen → services/runtime/dist/shejane-runtime/ (run it on THIS OS/arch only)"

##@ Lint & schemas
lint: ## Run the same lint checks CI runs
	@echo "→ ruff (Python)"
	@cd services/runtime && uv run ruff check . && uv run ruff format --check .
	@echo "→ project guards"
	@./scripts/check.sh
	@echo "✅ all lints pass"

schemas: ## Regenerate openapi.json + generated.ts from the daemon's pydantic models
	@./scripts/export-daemon-openapi.sh
	@pnpm --filter @shejane/runtime-sdk generate
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
	@case "$(COMPONENT)" in runtime|desktop|runtime-sdk) ;; *) echo "❌ COMPONENT must be runtime, desktop, or runtime-sdk" >&2; exit 1 ;; esac
	@case "$(VERSION)" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "❌ VERSION must look like X.Y.Z" >&2; exit 1 ;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "❌ Working tree not clean — commit or stash first." >&2; exit 1; fi
	@branch=$$(git rev-parse --abbrev-ref HEAD); if [ "$$branch" != "main" ]; then echo "❌ Releases must be cut from main (currently on '$$branch')." >&2; exit 1; fi
	git tag -a "$(COMPONENT)-v$(VERSION)" -m "$(COMPONENT) v$(VERSION)"
	git push origin "$(COMPONENT)-v$(VERSION)"
	@echo "✅ Pushed $(COMPONENT)-v$(VERSION). Only that module's release workflow will run."
##@ Eval
eval: ## Run the agent eval suite against a Runtime with a real provider
	cd services/runtime && uv run python -m local_host.eval

##@ Logs
logs-local-host: ## Tail the daemon log (.tmp/dev/local-host.log)
	./scripts/dev.sh logs local-host

logs-client: ## Tail the client Vite log
	./scripts/dev.sh logs client

logs-dev: ## Snapshot of all dev logs at once
	./scripts/dev.sh logs all
