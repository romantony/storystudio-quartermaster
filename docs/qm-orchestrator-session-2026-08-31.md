# Orchestrator design session + handoff — 2026-08-31

**Audience:** Quartermaster engineers.
**Status:** Design settled through Draft 3. Nothing built. Next artefact is an implementation document.
**Spec:** https://claude.ai/code/artifact/1ee33d6b-b99b-45cd-8717-e082b76ec008
**Related:** `docs/dynamodb-cost-fix-2026-08-10.md`, `src/shared/fleet.ts`, `src/handlers/provisioner.ts`, `src/handlers/shorts-trigger.ts`, `infra/lib/pipeline-stack.ts`.

## What happened today

### 1. DynamoDB cost fix — verified (the 2026-08-10 doc's "check back" step)

Ran the comparison the fix doc asked for, against the August Cost Explorer export.

| | Pre-fix (Aug 1 → Aug 10) | Post-fix (Aug 10 → Aug 31) |
|---|---|---|
| DynamoDB | $27.85 / 9.22d = **$3.02/day** | $26.06 / ~21.4d = **$1.22/day** |
| Run-rate | ~$92/mo, climbing | **~$37–40/mo** |

Lands inside the predicted $30–45/mo band, and the −60% shape matches the diagnosis (Scan half eliminated, Query half untouched).

**Caveat:** non-DynamoDB spend fell harder over the same window ($5.31/day → $1.86/day), so some of the drop is lower traffic rather than the fix. The clean traffic-independent signal is the CloudWatch Scan `SampleCount` — not run.

**The remaining $37–40/mo is the known gap, still unfixed at HEAD.** `reclaimExpired()` (`src/gate/dynamo-gate.ts`) and `scanQueuedCanonicalJobsByLane()` (`src/handlers/provisioner.ts`) each paginate the whole `queue-index` per lane every 2 minutes with a server-side filter. Pre-2026-08-10 `JobItem`s have no `ttl`, so this is flat forever, not decaying.

`docs/dynamodb-cost-fix-2026-08-10.md` still says "Follow-up verification pending" — it should be updated with the above.

### 2. ModelsLab residue removed (code change, uncommitted)

ModelsLab was decommissioned 2026-07-02. Removed what was genuinely dead:

- `src/adapters/modelslab.ts` (163 lines, unreachable — not in `ADAPTERS`)
- `modeslabKeySecretArn` prop + call site; `MODELSLAB_API_KEY_ARN` env on both Lambdas; the ARN from both `secretsmanager:GetSecretValue` grants
- `HighInflightAlarm` — watched `Quartermaster/modelslab_inflight`, a metric **nothing in the repo ever emits** (`PutMetricData` appears zero times). It sat in INSUFFICIENT_DATA for its whole life.

**Deliberately NOT removed: `COUNTER#modelslab`.** Despite the name it is the live, provider-agnostic global video/rest lane semaphore (`SAFE_LIMIT=15` / `VIDEO_FLOOR=8` / `REST_FLOOR=7`), driven by `POST /acquire` + `/release` from two Step Functions state machines. Comments in `dynamo-gate.ts`, `types.ts` and `database-stack.ts` now say so explicitly.

Verified: `tsc --noEmit` clean on root and infra; tests unchanged at 67 passed / 5 failed. `cdk synth` could not run locally (PowerShell `UnauthorizedAccess` while bundling `MergeFunction` — reproduced identically on clean HEAD, so pre-existing and environmental).

**Consequence to note:** the inflight ceiling now has no alarm. It never really had one, but the gap is now visible rather than papered over.

### 3. Database direction — settled

Evaluated Convex and Postgres against DynamoDB. Conclusion: **at 86,565 items / 57 MB / ~100 projects a month, the engine was never the problem — one bad access pattern was.** Every migration path costs more than the bug it would fix (Postgres-in-AWS is 5–10× a fixed DynamoDB, largely because RDS forces the Lambdas into a VPC and the executor then needs a NAT gateway at ~$33/mo). Postgres arrives anyway, but on the *new* background path, not as a migration of the old one.

### 4. Orchestrator architecture — Drafts 1 → 3

Ended at a **batch-window scheduler**. See the spec for detail; the shape is:

```
Convex → orchestrator (VPS) → planning agent → Postgres
      → 6h fixed tumbling window (00/06/12/18 UTC)
      → reallocate whole fleet to one endpoint
      → run cohort one phase at a time
```

Nine phases, two modes — **batch** (image, tts, i2v, bgm_sfx, merge, s2t, shorts) and **serverless** (video_generation, concat).

Three findings that shaped it:

- **Concat on GPU empties the VPS.** With NVENC concat as a serverless endpoint, no CPU-bound work remains on the host. VPS target dropped 8 vCPU/32 GB → **4 vCPU/16 GB**, bandwidth to single-digit GB/month.
- **40 workers is really ~33.** `fleet.ts` records 7 outside the QM pool (long2shorts 4, multitalk 2, LTX-DUB 1); two are needed *inside* the pipeline, so they join the rotation.
- **Reallocation must be verified, not fired.** The account cap is enforced silently — scaling up while others hold workers caps rather than errors. This is exactly the failure that silently lost 13+ of 17 frames (`fleet.ts`, 2026-07-05).

### 5. Unrelated gap surfaced

`shorts-longform` uploads `_shorts_manifest.json` but nothing reads it back — confirmed live 2026-07-11, all three clips rendered and uploaded while the project's `shorts` array stayed `[]`. Still open. The orchestrator closes it by construction if "shorts complete" is defined as "manifest read and clip URLs recorded".

---

## Tomorrow

### Blocking decisions — settle these first, they change the implementation doc

1. **Where does merge run?** CPU-only RunPod serverless endpoint (recommended, cheapest) vs sharing the GPU media endpoint with concat. Not AWS Lambda — that would put batch back on AWS.
2. **Remotion overlay** — the last AWS dependency in the background path, sitting between merge and concat. RunPod endpoint / fold into merge / documented exception.
3. **NVENC vs libx264 for concat.** Decides whether the concat endpoint needs a GPU at all, and therefore what to buy.
4. **Fleet reserve** — how many of the 40 workers the live AWS path may claim, so phases know their real ceiling.

### Then: write the implementation document

Take the spec down to modules, API calls, state transitions and build order. Suggested spine:

- [ ] Module map — orchestrator, planning agent, phase runner, fleet controller, batch client, webhook receiver, result assembler
- [ ] Phase runner state machine — states, transitions, and the persisted fields each needs
- [ ] Fleet controller — the §4.1 sequence as code, with the verification polls and their timeouts
- [ ] RunPod batch client — DRAFT/append/finalize/poll, pagination, the 10 MiB append ceiling, the 5,000-per-batch ceiling
- [ ] Migration/DDL for the four tables in §7, plus the partial indexes
- [ ] Idempotency rules — `projects.request_id`, `jobs.request_id`, resume-from-`batch_id`
- [ ] Repair-pass design — one fallback batch per phase, `tried_rungs` carried forward
- [ ] Build order and a first vertical slice (suggest: one project, phases A→C only, no repair pass)

### Smaller, independent

- [ ] Update `docs/dynamodb-cost-fix-2026-08-10.md` with the verification result above — it still says "pending"
- [ ] Decide whether to commit today's ModelsLab removal (working tree is dirty, 8 files, nothing committed)
- [ ] Optional: fix the live path's `queue-index` gap (status-scoped sparse index + `ttl` backfill, ~half a day, ~$37/mo → single digits)
- [ ] Optional: emit `total_inflight` from the sweeper and restore a real inflight alarm

### Deferred by agreement

- Pod count and GPU selection (constraint: NVENC yes, VRAM no — the RTX A4500's 20 GB would go unused)
- VPS hosting choice (Bluehost NVMe 16 now comfortably exceeds the 4 vCPU/16 GB target; mirror Postgres for failover/migration already planned)
- Cohort size cap and overflow policy
- Whether the two paths share one rung catalog or keep separate copies
