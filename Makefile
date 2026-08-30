.PHONY: help up down logs ps build test tidy run-api run-worker run-web clean

# Default target
help:
	@echo "Mini-Vercel Monorepo Commands:"
	@echo "  make up          - Start PostgreSQL and Redis via Docker Compose"
	@echo "  make down        - Stop Docker Compose services"
	@echo "  make logs        - Tail logs from Docker Compose services"
	@echo "  make ps          - View status of Docker containers"
	@echo "  make test        - Run all Go and frontend unit tests"
	@echo "  make build       - Build Go services (api, worker) and Next.js web"
	@echo "  make tidy        - Run go mod tidy on all Go modules"
	@echo "  make run-api     - Run Go API service locally (port 8080)"
	@echo "  make run-worker  - Run Go Queue Worker locally"
	@echo "  make run-web     - Run Next.js Web Dashboard locally (port 3000)"
	@echo "  make clean       - Remove built binaries"

# Docker Infrastructure
up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f

ps:
	docker compose -f infra/docker-compose.yml ps

# Go Modules & Tests
tidy:
	cd internal && go mod tidy
	cd apps/api && go mod tidy
	cd apps/worker && go mod tidy

test:
	go test -v -race ./apps/api/... ./apps/worker/... ./internal/...

build:
	@echo "Building Go API..."
	go build -o bin/api apps/api/cmd/server/main.go
	@echo "Building Go Worker..."
	go build -o bin/worker apps/worker/cmd/worker/main.go
	@echo "Building Next.js Web Dashboard..."
	cd apps/web && npm run build

# Local Execution
run-api:
	go run apps/api/cmd/server/main.go

run-worker:
	go run apps/worker/cmd/worker/main.go

run-web:
	cd apps/web && npm run dev

clean:
	rm -rf bin/
