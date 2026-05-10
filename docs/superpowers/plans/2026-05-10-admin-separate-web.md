# Separate Admin Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Phase 1.6 admin dashboard out of the user client into a separately deployable admin web app.

**Architecture:** Keep the existing backend admin APIs unchanged, add a dedicated `admin/` Vite React app that owns admin login and dashboard UI, and remove admin UI/API client code from `client/`. Add `ADMIN_BASE_URL` to backend config so production CORS can allow the separate admin domain.

**Tech Stack:** Go `net/http`, React 18, Vite, Vitest, Docker Compose, nginx static hosting.

---

### Task 1: Backend Admin Origin Support

**Files:**
- Modify: `api/internal/config/config.go`
- Modify: `api/internal/httpapi/server.go`
- Modify: `api/internal/httpapi/server_test.go`
- Modify: `.env.example`

- [ ] **Step 1: Write failing CORS test**

Add a test that configures `AdminBaseURL=https://admin.example.com`, sends a request with `Origin: https://admin.example.com`, and expects `Access-Control-Allow-Origin` to match that origin.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/httpapi -run TestAdminOriginAllowedByCORS -count=1`

- [ ] **Step 3: Implement config and CORS support**

Add `AdminBaseURL` to `config.Config`, load `ADMIN_BASE_URL`, and update server middleware to allow either `CLIENT_BASE_URL` or `ADMIN_BASE_URL`, while preserving localhost dev-origin behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/httpapi -run TestAdminOriginAllowedByCORS -count=1`

### Task 2: User Client No Longer Contains Admin

**Files:**
- Modify: `client/src/App.test.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/shared/api/client.ts`
- Modify: `client/src/styles.css`

- [ ] **Step 1: Write failing client test**

Change the client test so an admin-role user can still log into the normal client, but no “管理后台” entry appears.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --run src/App.test.tsx`

- [ ] **Step 3: Remove admin UI from client**

Delete `AdminDashboard`, admin-only state, admin imports, admin API methods/types, and admin CSS from the user client. Keep auth, chat, billing, import, and export behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --run src/App.test.tsx`

### Task 3: Dedicated Admin Web App

**Files:**
- Create: `admin/package.json`
- Create: `admin/vite.config.ts`
- Create: `admin/vitest.config.ts`
- Create: `admin/tsconfig.json`
- Create: `admin/vitest.setup.ts`
- Create: `admin/index.html`
- Create: `admin/src/main.tsx`
- Create: `admin/src/App.tsx`
- Create: `admin/src/App.test.tsx`
- Create: `admin/src/styles.css`
- Create: `admin/src/shared/api/client.ts`
- Create: `admin/Dockerfile`
- Create: `admin/nginx.conf`

- [ ] **Step 1: Write failing admin app test**

Create a Vitest test that logs in as an admin, switches into the dashboard automatically, verifies overview/users/provider state, and verifies credit adjustment validation.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd admin && npm test -- --run src/App.test.tsx`

- [ ] **Step 3: Implement admin app**

Build a focused admin UI with login/register, overview metrics, user search/detail, status update, extra-credit adjustment, usage list, order list, and provider status. If logged-in user is not `role=admin`, show an access-denied state and do not call admin data APIs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd admin && npm test -- --run src/App.test.tsx`

### Task 4: Deployment and Docs

**Files:**
- Modify: `Makefile`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/progress/phase-1-6-progress.md`

- [ ] **Step 1: Add build/test/deploy wiring**

Add `admin-test`, `admin-build`, include admin in `make test` and `make build`, and add an `admin` Docker Compose service on port `5174`.

- [ ] **Step 2: Update docs**

Document `ADMIN_BASE_URL`, `http://localhost:5174`, the separate deployment boundary, and that the normal client no longer includes admin UI.

- [ ] **Step 3: Run full verification**

Run: `make test`, `make build`, `docker compose up -d --build`, `curl -fsS http://localhost:8080/health`, `curl -fsS -I http://localhost:5173`, and `curl -fsS -I http://localhost:5174`.
