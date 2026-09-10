# Orchestrator build session + handoff — 2026-09-10

**Audience:** Quartermaster engineers.
**Status:** M0 done and running on the VPS. M0.5 done. M1 in progress (deploy + measure, not build). M2 not started.
**Plan:** `docs/qm-orchestrator-implementation-plan.md`. **Spec:** artifact `1ee33d6b-b99b-45cd-8717-e082b76ec008`.
**Predecessor:** `docs/qm-orchestrator-session-2026-09-09.md`.

## What happened today

### 1. ModelsLab decommission finished (`a5a8b9d`, pushed to `origin/main`)

The "ModelsLab-residue WIP" that had sat uncommitted since the 2026-08-31 session is
now in. One `chore(qm)` commit, 8 files, +37 / −192:

- **Deleted** `src/adapters/modelslab.ts` (163 lines; provider decommissioned
  2026-07-02, not in any catalog ladder) and removed it from `src/adapters/index.ts`.
- **Removed the secret wiring** — `MODELSLAB_API_KEY_ARN` / `modeslabKeySecretArn`
  out of `infra/bin/app.ts` and `infra/lib/api-stack.ts` (props, `providerSecretArns`,
  `providerSecretEnv`, Lambda env, grant list).
- **Dropped `HighInflightAlarm`** (`infra/lib/api-stack.ts`) — it watched
  `Quartermaster/modelslab_inflight`, a metric nothing has ever emitted, so it sat
  in INSUFFICIENT_DATA its whole life. Removed rather than left as false assurance.
  A comment now records that the lane semaphore ceiling (`SAFE_LIMIT=15`) is
  therefore **unmonitored** until someone emits `total_inflight` from the sweeper
  and re-adds an alarm against that.
- **Guard comments** in `src/gate/dynamo-gate.ts`, `src/types.ts`,
  `infra/lib/database-stack.ts`, `src/adapters/index.ts`: the `COUNTER#modelslab`
  pk is vestigial branding — the semaphore itself is the **live, provider-agnostic
  fleet-wide video/rest lane gate** the StoryStudio Step Functions pipeline holds
  via `/acquire` + `/release`. Do not delete it as dead ModelsLab code; renaming
  the pk needs a sequenced live counter migration, not a find-and-replace.
- **Re-worded** the Step Functions state comments in `infra/lib/pipeline-stack.ts`
  to name the generator Lambdas (`image-basic-generator`, `video-i2v-generator`)
  and the QM ladder instead of "ModelsLab / Wan 2.2 / Flux Klein".

Working tree is now clean. One item off yesterday's "smaller / independent" list.

---

## Still open — carried forward from 2026-09-09

### Blocking decisions — settle before the work they gate

1. **R2 for the `media` endpoint** — which bucket / account / public origin, and are
   credentials already provisioned (the live path uses `e2e-storystudio` /
   `pub-….r2.dev`)? Needed to deploy and to write the orchestrator's asset-persist path.
2. **Step 9 (`transcribe`)** — keep it, or let the M2 planner drop it? `caption`
   already returns its own `srt`. Keep only if the product wants a `.srt` timed to
   the *pre-concat per-frame* audio. (Affects the step DAG in the planner.)
3. **`concat` normalize gap** — the `media` endpoint's `concat` does **not** per-clip
   scale/pad/fps-lock (the ECS `concat-and-trim` did). Fine only if every cohort's
   i2v output is already uniform. Confirm, or a normalize pass has to be added to
   `flux4B-Wan2-storystudio`.

### M1 — finish it

- [ ] Deploy `flux4B-Wan2-storystudio` with `ENDPOINT_ROLE=all` as the `media`
      endpoint; note its `endpointId` for `fleet-registry.ts` (wired in M2).
- [ ] One job per mode (`merge`, `concat`, `upscale`, `caption`, `mix_bgm`) against
      a real cohort's assets → record `gen_time_s` + RunPod `executionTime` + peak
      VRAM. Feeds spec §8 rate card and §16 q4 (GPU class for this role).
- [ ] Confirm `caption` works with `ENDPOINT_ROLE=all` (needs Whisper resident).

### M2 — start it *(the big one)*

Per plan §13 M2 and §6.2–6.4:

- [ ] `fleet-registry.ts` extras — add `media` (+ `long2shorts`, `LTX-DUB`
      out-of-pool) as a hand-maintained companion to the generated pool; a test
      that the two don't overlap.
- [ ] **Planner** (`agents/planner.ts`) — request (§9.1 zod) → job graph → ordered
      step plan (§9.3), `drainAfter` from the endpoint-affinity rule,
      `deps_remaining` counter, one-txn write. Runs synchronously inside
      `POST /v1/requests`.
- [ ] **Generator** (`agents/generator.ts`) — claim loop (`FOR UPDATE SKIP LOCKED`),
      submit via `runpod/client.ts`, in-flight limit = verified worker count,
      webhook receiver + reconcile fallback, same-txn `runpod_job_id` write.
- [ ] **Fleet controller** (`agents/fleet.ts`) with `ORCH_FLEET_LIVE=false` — the
      §4.1 sequence as code (allocate → verify `workers.ready` → assert cap → ready;
      release → verify drained), logging every PATCH it *would* make. **No live
      scaling this milestone.**
- [ ] Port the per-step payload builders (`steps/builders/`) from
      `src/adapters/runpod.ts`'s `buildRunpodInput` cases + `media.md`'s modes —
      one pure function + one test each.
- [ ] Hand-scale one endpoint, run **steps 1→2→3 only**, one project, no gates —
      `job_costs` populated, zero programmatic scaling.

### Smaller / independent

- [ ] Rotate the VPS root password (`passwd root`); `rm -f /root/.ssh/qm_repo_deploy*`.
- [x] ~~Decide whether to commit the ModelsLab-residue WIP~~ — committed (`a5a8b9d`).
- [ ] Nightly `pg_dump` → object storage + an off-box Postgres mirror (spec §15.3) —
      still not wired.
- [ ] Update `docs/dynamodb-cost-fix-2026-08-10.md` with the verification result
      (still says "pending").

### Deferred by agreement

- Remotion overlay stays on AWS Lambda for M1 (§16 q3) — revisit as its own milestone.
- `qm-watchdog` container/unit (spec §6.9) — arrives with M3 (first live scaling).
- Wan 2.2 rung / CFG sweep (§7, §12.2) — M7.
- The live-path lease *writer* — M3.
