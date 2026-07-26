# StoryStudio → Per-Language Voice Selection & Defaults (`fourLang`)

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Subject:** which top-level fields control voice selection per language for a
`fourLang: true` narration project, split by tier, and exactly what QM falls
back to when a field is omitted.
**Status: current as of 2026-07-26.** This is a correction to — not a
duplicate of — `docs/storystudio-4lang-integration.md` §2.1 and
`storystudio-unified/docs/quartermaster/storystudio-4lang-video-pipeline-handoff.md`
§1. Read the "What changed" section below first if you've already integrated
against either of those.

---

## TL;DR

| Tier | Languages | Engine | Field(s) you send | If omitted |
|---|---|---|---|---|
| **Basic** | en, es, pt-BR, hi | **Kokoro, all four** | `voiceGender` (already sent) + optional `voiceIdEs`/`voiceIdPtBr`/`voiceIdHi` | QM picks a language+gender-matched Kokoro voice automatically — see table below |
| **Premium** | en, es, pt | Qwen voice-clone | `voiceCloneArtifactUrlEs`/`voiceCloneArtifactUrlPtBr` (**recommended, no good default**) | Falls back to a single generic, non-gendered, English-accented voice regardless of language |
| **Premium** | hi | Kokoro | `voiceIdHi` (optional) | Falls back to `hf_alpha` (female) — not gender-aware |

---

## What changed (2026-07-26)

`storystudio-4lang-video-pipeline-handoff.md` §1 describes StoryStudio
already sending `voiceCloneArtifactUrlEs`/`voiceCloneArtifactUrlPtBr` (Qwen
`.pt` clone URLs, defaulting server-side to `es-es-doc-f`/`pt-br-doc-f`) for
**Basic** `fourLang: true` projects, on the assumption that Basic's
per-frame TTS would route Spanish/Portuguese through Qwen when a clone URL
was present (mirroring Premium).

That assumption caused a live failure in the first Basic fourLang E2E test
(2026-07-26): RunPod's Qwen engine rejected the locale codes QM was sending
as its `language` param ("Invalid language 'es'/'pt-BR'"). Fixing that
surfaced the actual product decision: **Narration Basic uses Kokoro for all
four languages — Qwen voice clone is Premium-only.** QM's per-frame Basic
pipeline (`E2E-VideoGenerationPipeline-Narration-Basic-QM-New`) was changed
accordingly the same day.

**Practical effect for StoryStudio:**
- `voiceCloneArtifactUrlEs`/`voiceCloneArtifactUrlPtBr` are now **silently
  ignored** by QM for Basic `fourLang` projects. Not an error, just a no-op —
  safe to keep sending during migration, but they no longer influence
  anything for Basic. You can stop resolving/sending them for Basic once
  convenient.
- **Nothing changes for Premium.** Premium's whole-script `fourLang` flow
  (`localizationStates()`) is untouched — it still uses
  `voiceCloneArtifactUrlEs`/`PtBr` for Spanish/Portuguese exactly as
  `storystudio-4lang-integration.md` §2.1 and the handoff doc §1 describe.

---

## Narration Basic — per-frame flow, Kokoro-only

Fields (all **top-level on the `StartExecution` input**, one value per
project — not per-frame, same as today):

| Field | Type | Required? | Notes |
|---|---|---|---|
| `voiceGender` | `"male"` \| `"female"` | Already sent today | Now drives the default voice for **all four** languages, not just English (see table below). |
| `voiceIdEs` | string | Optional | Kokoro voice_id for Spanish, e.g. `em_alex`, `ef_dora`. |
| `voiceIdPtBr` | string | Optional | Kokoro voice_id for Portuguese, e.g. `pm_alex`, `pf_dora`. |
| `voiceIdHi` | string | Optional | Kokoro voice_id for Hindi, e.g. `hf_alpha`, `hm_omega`. |

If you omit `voiceId{Es,PtBr,Hi}` for a language, QM now resolves a real
default from `voiceGender` instead of one shared fallback voice for every
language:

| Language | Male default | Female default | Verified live? |
|---|---|---|---|
| Spanish | `em_alex` | `ef_dora` | **No** — added 2026-07-26, not yet sampled/confirmed on the pod |
| Portuguese | `pm_alex` | `pf_dora` | **No** — same as above |
| Hindi | `hm_omega` | `hf_alpha` | Yes — Whisper round-trip verified 2026-07-08 |

(English's existing default is unchanged and separate: `voiceGender` →
`am_adam`/`af_bella` on the single-language `voice.narrationBasic.tts` rung.)

**Practical guidance:** you don't need to send `voiceId{Es,PtBr,Hi}` to get a
correctly-languaged, gender-matched voice — the default now covers that. Send
them only if you want real voice variety per project (multiple voices per
language/gender, not just one canned default each). Treat the Spanish/
Portuguese defaults as unverified until QM confirms them live, the same
caution that applied to Hindi before its 2026-07-08 check.

---

## Narration Premium — whole-script flow, unchanged

No changes here — documented in full in `storystudio-4lang-integration.md`
§2.1 and the handoff doc §1. Repeated for contrast with Basic:

| Language | Field | Default if omitted |
|---|---|---|
| Spanish | `voiceCloneArtifactUrlEs` (Qwen `.pt` clone URL) | **No gender/language-aware default.** Falls back to a single fixed design-mode voice (`speaker: 'Ryan'`) — generic, non-gendered, and sounds English regardless of the target language. |
| Portuguese | `voiceCloneArtifactUrlPtBr` | Same fallback as Spanish. |
| Hindi | `voiceIdHi` (Kokoro) | Falls back to `hf_alpha` (female) — not gender-aware, unlike Basic's new default. |

**Practical guidance:** unlike Basic, Premium genuinely needs
`voiceCloneArtifactUrlEs`/`PtBr` sent — there's no safety net if they're
missing, and the fallback is a poor substitute (wrong accent/language
entirely, not just wrong gender). Keep resolving these from
`qwen-voice-clone/docs/voice-catalog.json` per project as you do today.

---

## Open item

Premium's own per-frame `fourLang` flow (mirroring what Basic got
2026-07-25/26) hasn't been built yet — Premium fourLang projects still use
the older whole-script post-concat design above. When Premium's per-frame
flow ships, expect it to keep Qwen for en/es/pt and Kokoro for hi (per
product direction), at which point this doc will get a Premium per-frame
section analogous to Basic's above.
