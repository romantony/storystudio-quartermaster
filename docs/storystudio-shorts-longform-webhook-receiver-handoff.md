# StoryStudio Handoff: Shorts-Longform Webhook Receiver Still Missing

**Date:** 2026-07-28
**Status:** Confirmed open gap, ~17 days old, independently found twice.
**Audience:** StoryStudio backend (Convex / E2E pipeline).

---

## 1. Summary

QM's `TriggerShortsFromLongForm` (`shortsTriggerStates()` in
`infra/lib/pipeline-stack.ts`, `src/handlers/shorts-trigger.ts`) fires a
fire-and-forget job on the `shorts-longform` RunPod worker
(`u3bvq5juben8ri`) whenever a project sets `generateShorts: true`. The job
runs, generates the shorts, and uploads them to R2 successfully. **Nothing
downstream ever reads that output back into Convex** — no `shorts` table
row gets created or updated, so the finished clips never surface anywhere
in StoryStudio.

This is not a new bug we're introducing — it's been open since at least
2026-07-11, confirmed independently twice now (see §3). We're raising it
again now because we just shipped an extension (per-language shorts for
`fourLang` projects, es/pt-BR/hi in addition to English — see §4) that
inherits the same gap ×4, and surfaces a second problem the receiver design
will need to account for.

## 2. "Doesn't the worker send the completed URL?" — yes, it does

Worth being precise about this, since it's easy to assume the worker is
the missing piece. It isn't. `shorts-trigger.ts` already supplies a
`webhook` URL in the RunPod `/run` payload:

```
webhook: "${convexEndpoint}/api/e2e/runpod-webhook?jobId=..."
```

RunPod's own serverless platform automatically POSTs the complete job
envelope (`id`, `status`, `output`) — including every `shorts[].video`/
`srt`/`audio` URL — to that address the moment the job finishes. This is
platform behavior, not something `~/longtoshort`'s code has to implement;
it's the same mechanism described in `STORYSTUDIO-INTEGRATION.md` §2 and
already works today (confirmed live, §3). **The video URL genuinely is
being sent. There's nobody listening on the other end.**

## 3. Evidence the receiver was never built

- **Full git-history search of `storystudio-unified`**
  (`git log --all -p -S"runpod-webhook"`, not just current `HEAD`): the
  string `runpod-webhook` appears in exactly one place in the entire
  history — `docs/quartermaster/storystudio-shorts-longform-integration.md`
  (added commit `329d848`), which only *references* the URL as the
  recommended pattern. No commit ever adds a matching route to `http.ts` or
  any Lambda. That doc is itself still stamped **"Status (2026-07-09): NOT
  YET INTEGRATED"** and its own §9 lists *"needs a webhook receiver"* as
  still-open.
- **`http.ts`'s current route table** has `/api/e2e/status` and
  `/api/e2e/start-shorts` registered — no `/api/e2e/runpod-webhook`, no
  wildcard that would catch it.
- **Live production confirmation, 2026-07-11** (from a prior Claude
  session's memory in this repo,
  `~/.claude/projects/-home-roman-antony-storystudio-unified/memory/shorts_longform_worker_replacement.md`):
  project `js75gpvt4jpa7xjvjyq97ga1z18a96yg`, RunPod job `9ida5vyeht75s4`
  fired and completed end-to-end — fetched the full-video SRT, selected 3
  highlight clips via Claude, rendered and uploaded all 3
  (`part{1,2,3}_short.mp4` + audio + SRT) plus a manifest to
  `storyaistudio.app/storystudio/{video,voice,txt}/`. **The project's
  `shorts` field in Convex stayed `[]`.** That session's conclusion: *"the
  actual gap is between the worker's manifest upload and whatever is
  supposed to read `_shorts_manifest.json` and write the 3 short entries
  back into the project's `shorts` array in Convex."*

Nothing in the 17 days since has closed this — no commit adds a receiver,
and no commit adds anything that reads `_shorts_manifest.json`.

## 4. New complication: our per-language extension needs this too, plus a schema change

We just shipped `fourLang` projects triggering Shorts for es/pt-BR/hi as
well as English (gated on the same `generateShorts` flag). Two things
whoever builds the receiver should know about:

1. **`project_id`/`jobId` sent to the worker are language-suffixed** for
   es/pt-BR/hi (e.g. `proj_abc-es`, English unchanged) — this avoids the
   worker's R2 keys and (once it exists) webhook correlation colliding
   across 4 parallel triggers for the same project. If the receiver feeds
   `project_id` straight into `upsertShortFromPipelineData`'s `projectId`
   argument (`v.id("projects")` — a real Convex document ID, not an
   arbitrary string), **the suffixed value will fail Convex's ID
   validator**. The receiver needs to strip the suffix back to the real
   project ID before that call, and capture the language separately (from
   the same suffix, or we can send it as an explicit field instead if
   that's easier on your side — happy to adjust the contract).
2. **The `shorts` table has no language dimension at all today**
   (`by_project_part` index, keyed only on `projectId` + `partNumber`).
   Even with a working receiver, there's nowhere to put es/pt-BR/hi rows
   without a schema change — either a `language` field added to the
   `shorts` table (defaulting existing rows to `"en"`) plus an index
   update, or a different storage strategy entirely. This is a real design
   decision on your side; we don't want to presume the shape.

## 5. What we're not prescribing

The receiver's auth model is also an open question we don't have a strong
opinion on: `/api/e2e/status` requires a verified JWT
(`applyStatusUpdateFromLambda` → `verifyE2EToken`), but RunPod's own
webhook call obviously can't carry that token — RunPod doesn't know about
it, it's opaque to the worker. Whatever validates the incoming RunPod
callback (shared secret in the query string, a lookup against the known
outstanding job, or something else) is your call.

The actual mapping logic already exists and works, just on a different
path — `E2E-shorts-deliver`'s `_map_short()`
(`infrastructure/lambda/functions/E2E-shorts-deliver/lambda_function.py`)
already converts one RunPod `shorts[]` entry into exactly the shape
`upsertShortFromPipelineData`/`syncPipelineUpdate` expect. A new webhook
receiver could very plausibly reuse that same mapping function against the
RunPod webhook payload instead of (or in addition to) `E2E-shorts-deliver`'s
own polling result — same `output.shorts[]` shape either way, per
`STORYSTUDIO-INTEGRATION.md` §7's own note that the webhook payload and the
`/status/{id}` poll result are identical.

## 6. How to verify once built

Same technique the 2026-07-11 session used: create a project with
`generateShorts: true` (add `fourLang: true` too, to exercise the new
per-language path), then query the `shorts` table directly against prod:

```bash
cd backend && npx convex run --prod e2e/shorts:getShortsByProject '{"projectId":"..."}'
```

A non-empty array — with 4× the row count once the schema/language
question in §4 is resolved — means it worked.
