.PHONY: test build api-test client-test admin-test client-build admin-build dev docker-up docker-down migrate smoke-real-llm

test: api-test client-test admin-test

build:
	cd api && go build ./cmd/api
	cd client && npm run build
	cd admin && npm run build

api-test:
	cd api && go test ./...

client-test:
	cd client && npm test -- --run

admin-test:
	cd admin && npm test -- --run

client-build:
	cd client && npm run build

admin-build:
	cd admin && npm run build

dev:
	@echo "Run API, client, and admin in three terminals:"
	@echo "  cd api && HTTP_ADDR=:8080 go run ./cmd/api"
	@echo "  cd client && npm run dev"
	@echo "  cd admin && npm run dev"

docker-up:
	docker compose up --build

docker-down:
	docker compose down

migrate:
	psql "$$DATABASE_URL" -f api/migrations/001_phase1.sql

smoke-real-llm:
	./scripts/smoke-real-llm.sh
