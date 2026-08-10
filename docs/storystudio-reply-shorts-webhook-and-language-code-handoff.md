# StoryStudio reply: webhook receiver is now built; one remaining item found in `longtoshort`

**Audience:** Quartermaster / `longtoshort` (shorts-longform RunPod worker) maintainers
**Subject:** response to `storystudio-shorts-longform-webhook-receiver-handoff.md`
(2026-07-28) — the missing Convex-side receiver is now implemented; while wiring it up
we found one thing that likely needs a fix in `longtoshort` itself for the 4lang shorts
extension to actually transcribe/caption correctly.
**Status:** StoryStudio side done. One item below (`language` code format) is a request
for your team — we don't own `longtoshort`'s code.

---

## 1. What we fixed (context, not an ask)

`POST /api/e2e/runpod-webhook` now exists in `backend/convex/http.ts`, backed by
`applyRunpodShortsWebhook` (`backend/convex/e2e/shorts.ts`). It:

- Parses the `jobId` query param, stripping the `-es`/`-ptBr`/`-hi` suffix your
  `finalizeLocalizedBranch` (`pipeline-stack.ts:2300-2301`) already appends, to recover
  the base `e2eJobs.jobId` + the language.
- Looks the base jobId up in `e2eJobs` (this is also the auth model — an unrecognized
  jobId is rejected with 404; there's no separate shared secret since RunPod's webhook
  POST can't carry custom headers).
- Reads `payload.output.shorts[]` (same shape `E2E-shorts-deliver`'s `_map_short` already
  consumes — we ported that mapping to TypeScript rather than inventing a new shape) and
  upserts each part into the `shorts` table via the existing
  `upsertShortFromPipelineData` mutation.
- Added `shorts.language` (schema.ts) + a `by_project_language_part` index, since es/pt-BR/hi
  each run independent AI clip selection and reuse `partNumber` 1..N — English's existing
  rows (no `language` field) are untouched and keep resolving through the old
  `by_project_part` index, so this required no backfill/migration.

No changes needed on your side for this part — `shorts-trigger.ts` and
`finalizeLocalizedBranch`'s webhook URL construction were already correct; the gap really
was purely "nobody was listening," as your doc concluded.

## 2. Thing we think *does* need a `longtoshort` fix: `language` isn't normalized to ISO-639-1

`finalizeLocalizedBranch` (`pipeline-stack.ts:2279`, `:2305`) sends `language: langCode`
where `langCode` is **`'pt-BR'`** for Portuguese (matching StoryStudio's own
`localizedAssets`/`fourLangVoiceConfig` convention of using `pt-BR`, not `pt`, everywhere
else). That value flows straight through to RunPod's job `input.language`.

In `longtoshort`, `handler.py:112` takes that value completely as-is:

```python
language = str(inp.get("language") or DEFAULT_LANGUAGE)
```

and passes it unmodified into both transcription paths:

- `shorts/transcribe.py:101-102` — `payload["language"] = language` sent to the
  Flux-TTS-S2T `transcribe` endpoint.
- `shorts/transcribe.py:147` — `model.transcribe(language=language or None, ...)`
  (faster-whisper local fallback).

Whisper (and, as far as we can tell from the payload shape, the Flux-TTS-S2T endpoint
too) expects bare ISO-639-1 codes — `"en"`, `"es"`, `"pt"`, `"hi"` — not BCP-47-style
region-tagged codes. `"pt-BR"` isn't a key faster-whisper's language table recognizes, so
`transcribe_local`'s `language="pt-BR"` call looks like it would raise rather than
transcribe. We haven't run a live pt-BR shorts job against `longtoshort` to confirm the
exact failure mode on the remote Flux-TTS-S2T endpoint (that's a separate service we
don't have visibility into), but the local faster-whisper path is enough to be fairly
confident this is a real problem, not just a theoretical one.

**Es/hi are unaffected** — `'es'` and `'hi'` are already bare ISO-639-1 codes, so only the
Portuguese case hits this.

### Suggested fix (your call on exact placement)

Normalize the incoming `language` value to its bare ISO-639-1 form before it reaches
either transcription path — e.g. in `handler.py`'s `_transcribe_short`, something like
`language.split('-')[0].lower()` (turns `pt-BR` → `pt`, leaves `en`/`es`/`hi` unchanged).
We'd suggest doing it once at the point `language` is read (`handler.py:112`) rather than
in both `transcribe.py` call sites, so any other future consumer of that same value
(e.g. the highlight-selection prompt, `shorts/highlights.py`, which currently just says
"same language as the transcript" and doesn't consume the code directly) isn't affected
either way.

We didn't make this change ourselves since it's entirely inside `longtoshort`, not
`quartermaster` or `storystudio-unified`.

## 3. Everything else in your handoff doc

§4's `project_id`/`jobId` language-suffixing and §4's schema-decision ask are both
addressed by §1 above. §5's auth-model question is answered by the lookup-against-known-job
approach described there. §6's verification recipe
(`npx convex run --prod e2e/shorts:getShortsByProject`) will now return rows — including a
`language` field per row — once a real 4lang + `generateShorts: true` project runs through.
