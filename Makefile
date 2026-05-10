.PHONY: test build api-test client-test client-build dev docker-up docker-down migrate

test: api-test client-test

build:
	cd api && go build ./cmd/api
	cd client && npm run build

api-test:
	cd api && go test ./...

client-test:
	cd client && npm test -- --run

client-build:
	cd client && npm run build

dev:
	@echo "Run API and client in two terminals:"
	@echo "  cd api && HTTP_ADDR=:8080 go run ./cmd/api"
	@echo "  cd client && npm run dev"

docker-up:
	docker compose up --build

docker-down:
	docker compose down

migrate:
	psql "$$DATABASE_URL" -f api/migrations/001_phase1.sql
