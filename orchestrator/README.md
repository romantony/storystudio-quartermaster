# @qm/orchestrator

Window scheduler for MCP-originated background video generation.
Implements *Quartermaster Orchestrator — Architecture Specification, Draft 4*
([spec](https://claude.ai/code/artifact/1ee33d6b-b99b-45cd-8717-e082b76ec008)),
per `docs/qm-orchestrator-implementation-plan.md`.

New workspace, not a new repo — shares the root `tsconfig`/`jest` config and the
`@qm/*` path alias so ported pure functions test against the same fixtures the
Lambda path uses.

## Status — M0 (Foundations)

What exists:

| Piece | File | Notes |
|---|---|---|
| Config | `src/config.ts` | zod, fail-fast, frozen. Defaults = impl plan §17. |
| pg pool | `src/db/pool.ts` | one per process, `statement_timeout`, `pingDb()` for health. |
| Migrations | `src/db/migrations/001`–`005` | `001` = spec §10 verbatim; `002`–`004` = plan §4.2–4.4; `005` = plan §4.5 invariants. |
| Migration runner | `src/db/migrate.ts` | `up` / `down` / `status`; each migration is one reversible `.sql` file split on `-- @DOWN`. |
| Fleet registry | `src/fleet-registry.ts` | **generated** from `src/shared/fleet.ts` by `scripts/gen-fleet-registry.ts`. |
| RunPod client | `src/runpod/client.ts` | `/run` `/status` `/cancel` `/health` + management PATCH; jittered backoff on Transient; per-call timeout. No live calls in tests. |
| HTTP server | `src/http/server.ts` | Fastify; `GET /v1/health` only. |
| Entry | `src/index.ts` | config → pool → server → shutdown hooks. Agent loops wired in from M2. |

Not yet: planner, fleet, generator, quality agents; window scheduler; ingest and
webhook routes; the live-path lease (M0.5, AWS side).

## Develop

```sh
npm install                 # from repo root — installs the workspace
cd orchestrator
cp env.example .env         # set DATABASE_URL + the two tokens

npm run gen:fleet            # regenerate src/fleet-registry.ts from ../src/shared/fleet.ts
npm run migrate              # apply 001..005   (needs a reachable Postgres)
npm run migrate:down         # revert the last migration
npm run migrate:status       # applied / pending

npm run dev                  # start on :8080
curl localhost:8080/v1/health
```

Tests run from the repo root under the shared jest config:

```sh
npm test -- orchestrator
```

## M0 exit criteria — met

- [x] migrations apply and roll back cleanly — verified on the VPS 2026-09-09
      against Postgres 16: `up` applies `001`–`005`, `down` reverts `005`, `up`
      re-applies it. `migrations.test.ts` guards reversibility structurally in CI.
- [x] `/v1/health` reports pg reachable (200 `{"pg":{"ok":true}}`) / unreachable (503)
- [x] `fleet-registry.ts` divergence is a test failure

## Deploy (VPS)

Dedicated Bluehost NVMe8 box, `orchestrator.ai-storystudio.com` → 129.121.78.38.
`/opt/qm-orchestrator/` holds `docker-compose.yml` (postgres:16 `db` + `orchestrator`
built from `./repo/orchestrator`) and `.env`. Deploy = `git -C repo pull &&
docker compose build orchestrator && docker compose run --rm orchestrator node
dist/db/migrate.js up && docker compose up -d orchestrator`. Migrations are an
explicit step, never automatic on boot.
