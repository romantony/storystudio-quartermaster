# Orchestrator build session + handoff — 2026-09-09

**Audience:** Quartermaster engineers.
**Status:** M0 done and running on the VPS. M0.5 done. M1 in progress (deploy + measure, not build).
**Plan:** `docs/qm-orchestrator-implementation-plan.md`. **Spec:** artifact `1ee33d6b-b99b-45cd-8717-e082b76ec008`.
**Predecessor:** `docs/qm-orchestrator-session-2026-08-31.md`.

## What happened today

### 1. M0 — Foundations — DONE, verified live

`orchestrator/` workspace: `config.ts` (zod fail-fast, frozen), `db/pool.ts`, `db/migrate.ts`
(reversible `.sql` runner, `-- @DOWN` split), migrations `001`–`005` (`001` = spec §10 verbatim;
`002`–`004` = plan §4.2–4.4; `005` = §4.5 invariants + `verify_invariants()`), `fleet-registry.ts`
(generated from `src/shared/fleet.ts`, divergence is a test failure), `runpod/client.ts`
(`/run` `/status` `/cancel` `/health` + mgmt PATCH, jittered backoff on Transient, per-call
`AbortController` deadline), Fastify `http/server.ts` (`GET /v1/health` only), `index.ts`,
multi-stage non-root `Dockerfile`. 28 tests.

Commits `ab7f402`, `8e735ba` (`005` fix — `steps` has `seq` not `step_seq`; the aggregate-in-WHERE
error), `eec0f23`. **All three M0 exit criteria met against live Postgres 16 on the VPS:**
migrations apply, `down`→`up` round-trips, `/v1/health` → 200 `{"pg":{"ok":true}}`.

### 2. The VPS — provisioned and hardened

Dedicated Bluehost NVMe8 (`orchestrator.ai-storystudio.com` → 129.121.78.38, `hal-server-861762`,
Ubuntu 24.04, 4 vCPU / 7.8 GB / 193 GB) — **its own box**, not the one running
`agent.`/`social.ai-storystudio.com`.

- Docker 29.8 + compose v5.5, 4 GB swap, `ufw` 22/80/443
- `/opt/qm-orchestrator/` compose stack: `db` (postgres:16), `orchestrator` (built from
  `./repo/orchestrator`, `127.0.0.1:8080`), `caddy` (`caddy:2`, Let's Encrypt TLS-ALPN-01)
- SSH hardened — `/etc/ssh/sshd_config.d/00-hardening.conf` (sorts before `50-cloud-init.conf`):
  password auth off, key-only, `PermitRootLogin prohibit-password`. Key login verified from the PC.
- Runbook: `docs/qm-orchestrator-vps-access.md`

### 3. M0.5 — the live-path ownership lease — DONE (`d138d71`)

`EndpointLeaseItem` (`pk='ENDPOINTLEASE'`, `sk=counterKey`, mandatory `expiresAt`). `provisioner.ts`:
`readEndpointLeases()`; `runProvisioner` skips any endpoint under a non-expired lease — no plan,
no PATCH, no cap-count. `rebalanceUnderCap(plans, cap)` called as `ACCOUNT_CAP − sum(leased)`.
`__tests__/provisioner.test.ts` 6 → 9 tests, green. The lease *writer* (orchestrator fleet agent)
lands with M3. (`src/types.ts` also holds the still-uncommitted ModelsLab-comment WIP — only the
`EndpointLeaseItem` hunk was staged.)

### 4. M1 — corrected from "build" to "reuse"

First cut (`059a4ad`) built a fresh ffmpeg `media` RunPod container — five ops, R2 io, tests.
**Then `romantony/flux4B-Wan2-storystudio`** (the `flux-tts-s2t` / `bgm-s2t` codebase) turned out
to already implement `merge` / `concat` / `upscale` / `caption` / `mix_bgm` **and** `postprod`, on
Cloudflare R2, in production — with a role-table comment saying `concat`/`mix_bgm` were left
resident *"for when QM-New routes to them."* That is the impl-plan §1 "build on, do not rebuild"
case.

**Reverted (`ed5c111`).** Replaced with `orchestrator/containers/media.md` — the 5 modes'
input/output contract, `ENDPOINT_ROLE=all` deploy, and the behaviours the orchestrator must
handle. New reference memory: `flux4b-wan2-worker-repo`.

**Decision taken:** caption = Whisper-regenerated from the concatenated video; it does **not**
consume step 9's SRT.

---

## Tomorrow

### Blocking decisions — settle before the work they gate

1. **R2 for the `media` endpoint** — which bucket / account / public origin, and are credentials
   already provisioned (the live path uses `e2e-storystudio` / `pub-….r2.dev`)? Needed to deploy
   and to write the orchestrator's asset-persist path.
2. **Step 9 (`transcribe`)** — keep it, or let the M2 planner drop it? `caption` already returns
   its own `srt`. Keep only if the product wants a `.srt` timed to the *pre-concat per-frame*
   audio. (Affects the step DAG in the planner.)
3. **`concat` normalize gap** — the `media` endpoint's `concat` does **not** per-clip
   scale/pad/fps-lock (the ECS `concat-and-trim` did). Fine only if every cohort's i2v output is
   already uniform. Confirm, or a normalize pass has to be added to `flux4B-Wan2-storystudio`.

### M1 — finish it

- [ ] Deploy `flux4B-Wan2-storystudio` with `ENDPOINT_ROLE=all` as the `media` endpoint;
      note its `endpointId` for `fleet-registry.ts` (wired in M2).
- [ ] One job per mode (`merge`, `concat`, `upscale`, `caption`, `mix_bgm`) against a real
      cohort's assets → record `gen_time_s` + RunPod `executionTime` + peak VRAM. Feeds spec §8
      rate card and §16 q4 (GPU class for this role — NVENC + the SRVGG model's working set).
- [ ] Confirm `caption` works with `ENDPOINT_ROLE=all` (needs Whisper resident).

### M2 — start it *(the big one)*

Per plan §13 M2 and §6.2–6.4:

- [ ] `fleet-registry.ts` extras — add `media` (+ `long2shorts`, `LTX-DUB` out-of-pool) as a
      hand-maintained companion to the generated pool; a test that the two don't overlap.
- [ ] **Planner** (`agents/planner.ts`) — request (§9.1 zod) → job graph → ordered step plan
      (§9.3), `drainAfter` from the endpoint-affinity rule, `deps_remaining` counter, one-txn
      write. Runs synchronously inside `POST /v1/requests`.
- [ ] **Generator** (`agents/generator.ts`) — claim loop (`FOR UPDATE SKIP LOCKED`), submit via
      `runpod/client.ts`, in-flight limit = verified worker count, webhook receiver + reconcile
      fallback, same-txn `runpod_job_id` write.
- [ ] **Fleet controller** (`agents/fleet.ts`) with `ORCH_FLEET_LIVE=false` — the §4.1 sequence
      as code (allocate → verify `workers.ready` → assert cap → ready; release → verify drained),
      logging every PATCH it *would* make. **No live scaling this milestone.**
- [ ] Port the per-step payload builders (`steps/builders/`) from `src/adapters/runpod.ts`'s
      `buildRunpodInput` cases + `media.md`'s modes — one pure function + one test each.
- [ ] Hand-scale one endpoint, run **steps 1→2→3 only**, one project, no gates — `job_costs`
      populated, zero programmatic scaling.

### Smaller / independent

- [ ] Rotate the VPS root password (`passwd root`); `rm -f /root/.ssh/qm_repo_deploy*`.
- [ ] Decide whether to commit the ModelsLab-residue WIP (`infra/*`, `src/adapters/*`,
      `src/gate/dynamo-gate.ts`, `src/types.ts` comments, `modelslab.ts` deletion) — untouched
      since the 2026-08-31 session.
- [ ] Nightly `pg_dump` → object storage + an off-box Postgres mirror (spec §15.3) — still not wired.
- [ ] Update `docs/dynamodb-cost-fix-2026-08-10.md` with the verification result (still says "pending").

### Deferred by agreement

- Remotion overlay stays on AWS Lambda for M1 (§16 q3) — revisit as its own milestone.
- `qm-watchdog` container/unit (spec §6.9) — arrives with M3 (first live scaling).
- Wan 2.2 rung / CFG sweep (§7, §12.2) — M7.
- The live-path lease *writer* — M3.
