.PHONY: test test-ci test-e2e build api-test client-test admin-test local-host-test client-build admin-build local-host-build dev dev-electron dev-fresh docker-up docker-down migrate logs-api logs-local-host logs-client logs-llm-errors logs-dev smoke-local-host smoke-agent-research smoke-docker-local smoke-real-llm smoke-stripe-webhook smoke-s3-document smoke-external doctor

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

docker-up:
	docker compose up --build

docker-down:
	docker compose down

migrate:
	@for file in api/migrations/*.sql; do psql "$$DATABASE_URL" -f "$$file"; done

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
