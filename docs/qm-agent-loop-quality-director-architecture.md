# QM Agent Loop — Director + real-time Quality gates + learning rule store

**Audience:** Quartermaster engineers + StoryStudio integration owners.
**Status:** design proposal, not built. Builds directly on three things that already exist:
the QA+rework pair shipped 2026-08-10 for Dialogue-Basic-QM-New (`docs/qm-implementation-plan.md`
companion — see `infra/lib/pipeline-stack.ts`'s `NormalizeCharacterBible`→`RestoreContextDialogueBasic`
chain), a proactive learned-rule pattern already working end-to-end in a sibling repo
(`storystudio-agent/storyframe_qa_agent` + `storyframe_agent/prompt_builder.py`) that this
doc adapts for QM, and StoryStudio's existing MCP-facing agent pattern (`mcp.ai-storystudio.com`,
Lambda `storystudio-agent-mcp` — `create_project`/`validate_api_key` tools today; this is the
closest real analog found for the "`agent.ai-storystudio.com` via MCP" proposal evaluated in §4,
no `agent.ai-storystudio.com` exists in either codebase as of this writing).

**Decisions locked (2026-08-10):**
1. Any component that regenerates an image or video — Lambda or Docker, inline or MCP-invoked
   — routes through `qm-generate`, never a provider directly. Non-negotiable: this is the
   entire reason QM's admission gate and capacity manager exist.
2. Step Functions' own execution state is the single source of truth for "is this asset
   QA-passed" during a live run. Convex is a write-only mirror (StoryStudio UI/observability)
   — never read back mid-pipeline to make a gating decision. See §4 for why.

---

## 1. The gap this closes

What shipped 2026-08-10 is a **single post-hoc gate**: QA runs once, after every scene's
image *and* video are already generated, right before concat. That catches real defects
(verified live — a genuine P0 hallucination flagged on the first smoke test) but has two
costs:

1. **Wasted generation spend.** If the still image already has a hallucinated duplicate
   body, Wan2 i2v still animates it — full video-generation cost paid on an asset QA was
   always going to reject.
2. **No memory.** Every project re-discovers the same defect classes from zero. Rework
   fixes *this* frame's prompt; nothing carries the lesson into the *next* project's
   prompt generation. The same `HALLUCINATION_VISUAL` pattern (ambiguous single-character
   framing that diffusion models render as multiple bodies) will keep recurring at the
   same rate indefinitely.

This doc proposes closing both gaps: move the quality check **earlier and in-line** (gate
the image before video generation, gate the video before concat — not one batched pass at
the end), and add a **Director Agent + rule store** so findings feed forward into how
prompts get written *before* generation, not just how they get fixed after.

---

## 2. Prior art already proven: the rule-store loop

Before designing anything new, it's worth being precise about what already exists and
works, in `/home/roman-antony/storystudio-agent` (a separate repo from both quartermaster
and storystudio-unified):

- **`storyframe_qa_agent/rule_store.py`** — `load_rules()`/`save_rules()` (S3-backed),
  `generate_recommendations()` (mines a QA run's `frame_results` for issue categories
  recurring in ≥20% of frames), `persist_fix_rules()` (turns a recurring category into a
  concrete rule via a category→template map — e.g. `HALLUCINATION_VISUAL` →
  `"ONLY [character_name] in frame. No other human figures, faces, or silhouettes."`
  appended to the image prompt, plus a negative-prompt addition), and
  `retire_underperforming_rules()` (rules applied ≥10 times with <50% success get retired
  automatically).
- **`storyframe_agent/prompt_builder.py::apply_qa_learned_rules()`** — the *consumption*
  side: every new shot's prompt gets run through the active rule store before it's ever
  sent to a generation model. A rule fires if its `trigger` expression matches the shot
  (e.g. `characters_present.length == 1`), and its `value`/`appendToNegative` get spliced
  into the prompt.
- **Wired synchronously**: `storyframe_qa_agent/lambda_function.py` calls
  `generate_recommendations()` + `retire_underperforming_rules()` at the end of *every* QA
  run — no separate scheduled job. Today it only mines recurrence *within one project's*
  frames (≥20% of that project), which is a real limitation for catching a pattern that
  shows up at a lower rate spread across many projects — worth widening when this is
  adapted for QM (§6).

This is precisely the "the more we analyse, the fewer repeat issues" mechanism the
question asked about — it already exists and already works, just not for QM/dialogue-basic
yet, and not wired to gate *before* video generation.

---

## 3. Proposed architecture

Three agent roles, one shared rule store:

```
                         ┌─────────────────────────────────────────┐
                         │              RULE STORE (S3)             │
                         │  learned prompt-fix rules, keyed by      │
                         │  issue category, per project type        │
                         │  {trigger, action, value, negPrompt,     │
                         │   effectiveness: {applied, prevented}}   │
                         └───────────────┬───────────────┬─────────┘
                            reads (every        writes (after
                            prompt, pre-gen)     every QA run)
                                 │                        │
                                 ▼                        │
   ┌──────────────┐      ┌─────────────┐           ┌─────────────┐
   │   DIRECTOR    │─────▶│  image t2i  │──────────▶│   QUALITY    │
   │ enrich prompt │      │  / i2i gen  │  gate 1   │ image check  │
   │ w/ known fixes│      │  (qm-gen)   │◀──rework──│  (VLM score) │
   └──────────────┘      └─────────────┘   loop     └──────┬──────┘
                                                             │ pass
                                                             ▼
                                                      ┌─────────────┐
                                                      │  video i2v  │
                                                      │  (qm-gen)   │
                                                      └──────┬──────┘
                                                             │
                                                      ┌─────────────┐
                                                      │   QUALITY    │
                                                      │ video check  │◀──rework loop
                                                      │  (VLM score) │   (writes findings
                                                      └──────┬──────┘    back to rule store)
                                                             │ pass
                                                             ▼
                                                   only QM-passed scenes
                                                   reach ConcatenateScenes
```

### 3.1 Director Agent (new)

Runs **before** any generation call — reads the rule store for the project's tier
(`dialogueBasic`, `narrationPremium`, ...), evaluates each rule's `trigger` against the
scene being built (character count, scene keywords, beat type — same lightweight
expression matching as `_evaluate_trigger` above, no LLM call needed for this step, so it's
cheap and fast), and splices matching `value`/`appendToNegative` text into the prompt
*before* it's sent to `qm-generate`. This is the direct, proactive counterpart to what
`dialogue-basic-rework-prompts` already does *reactively* — same rule vocabulary, applied
earlier, using an LLM only when a rule's fix needs to be composed for the first time (rule
*creation* is the expensive LLM step; rule *application* is cheap pattern-matching).

Concretely, for dialogue-basic this is a Task inserted right before `RouteSceneImageGen` in
`dialogueBasicScenesBranch` (`infra/lib/pipeline-stack.ts`), rewriting `$.imagePrompt` (and
`$.videoPrompt`) in place using the same rule-store S3 object the Quality Rework loop
writes to.

### 3.2 Quality Agent — two real-time gates, not one batched pass

Split `dialogue-basic-qa-agent`'s work into two smaller, earlier checks, run **inline
inside `dialogueBasicScenesBranch`'s per-scene Map iterator** (`MaxConcurrency: 15`, so this
is already naturally "real-time per project" — every scene is checked as soon as its own
asset exists, in parallel with every other scene, not batched at the end):

- **Gate 1 (image):** runs immediately after `QMGenerateSceneImageT2I`/`I2I`, before
  `QMGenerateSceneVideo`. Image-only VLM call (cheap, ~10-15s) — reuses
  `dialogue_basic_qa/image_evaluator.py` unchanged. Fail → rework loop (rewrite prompt via
  Director's rule vocabulary + a fresh LLM correction where no rule exists yet →
  regenerate image → re-gate, capped at 2 attempts) → only then proceed to i2v. **This is
  the change that stops paying for i2v on images that were always going to fail QA.**
- **Gate 2 (video):** runs immediately after `QMGenerateSceneVideo`, before
  `BuildSceneResult`/concat. Reuses `dialogue_basic_qa/video_evaluator.py` unchanged. Fail
  → rework loop (regenerate video, or image+video if the defect is anatomy/hallucination
  rooted in the source frame) → re-gate, capped at 2 attempts → only QM-passed clips ever
  reach `ConcatenateScenes`.

Both gates already exist as working code (`image_evaluator.py`/`video_evaluator.py`,
smoke-tested live 2026-08-10) — this is a wiring change (move the check inline, twice, per
scene) not a rewrite. The single post-hoc `QaAgentDialogueBasic` pass built this session
either gets removed (fully superseded) or kept as a final holistic sanity check across the
whole reconciled project — worth deciding once inline gating is live and its false-negative
rate is known.

### 3.3 Rework Agent (already built, extended)

`dialogue-basic-rework-prompts` (LLM-only prompt correction) + native `qm-generate` Tasks
(`jobType: 'realtime'`, leading with KIE/Replicate instead of a cold self-hosted pod — per
2026-08-10's decision) stay exactly as built. The only change: it now fires at *either*
gate (image or video), and every correction it produces is a **candidate rule** — if the
same issue category fires ≥N times for the same project type, `generate_recommendations()`
(adapted from `rule_store.py`) promotes it from "one-off LLM correction" to "rule the
Director applies automatically, no LLM call needed" going forward.

---

## 4. Where does this run — Lambda-inline vs. Docker + MCP?

Two proposals were evaluated for how Director/Quality/Rework are actually deployed and
invoked. This section documents both and the recommended hybrid.

### 4.1 Option A — Lambda-inline (§3 as written)

Director and both Quality gates are stateless Task states inside the existing Step
Functions Map, reading/writing the same S3 rule store. Nothing needs a long-running
process:

- "Real-time monitoring of each project" is already what Step Functions *is* — every
  execution is its own live, inspectable state machine; moving the gates inline just means
  each scene's own Map iteration checks itself immediately instead of waiting for a
  separate end-of-project pass.
- "Retain memory" is the rule store (S3 JSON), read on every prompt and written after every
  QA finding — persistence, not a running process.
- The rule-*matching* step (Director) is deliberately non-LLM (trigger expressions against
  known fields) specifically so it stays cheap enough to run on every single scene without
  needing a warm process to amortize cost across.

**Con:** every QA/rework call today is one-shot classify-and-return (send image+prompt to
a VLM, get JSON back) — not a genuine multi-turn agentic loop. That caps reasoning quality:
the model can't decide to look closer, compare against a second reference, or hold
cross-scene context across a whole project's worth of frames in one line of reasoning.

### 4.2 Option B — Docker + MCP (`agent.ai-storystudio.com`), as proposed

Proposal: QA and Rework run as persistent Docker services, invoked via MCP from an
`agent.ai-storystudio.com`-style endpoint. Data (image prompt + URL) comes either from the
Step Functions payload or a Convex read for the project's current state; Step Functions
checks QA-passed status before video generation and before concat, calling the rework agent
for an updated asset if not.

No `agent.ai-storystudio.com` exists in either codebase — the closest real precedent is
`mcp.ai-storystudio.com` (Lambda `storystudio-agent-mcp`, `storystudio-unified/mcp/`), which
already exposes MCP tools (`create_project`, `validate_api_key`) for external agents to
drive StoryStudio. The proposal is best read as "extend that same interface pattern to
quality assurance," which is a reasonable instinct — it keeps QM's interface consistent with
how the rest of the system is already built to be operated by agents, and Docker +
persistent connection genuinely does unlock the multi-turn reasoning Option A caps out on.

**Two problems identified, both resolved by the locked decisions above:**

1. **Dual source of truth (SFN payload vs. Convex read).** Two systems independently
   tracking "is this asset QA-passed" will disagree eventually — Rework writes a new image
   URL to Convex, but Step Functions is mid-execution against its own payload snapshot, or
   an execution retries a step and Convex has a stale partial write from the attempt before.
   **Resolved:** Step Functions execution state is authoritative during a run (decision
   #2); Convex receives writes for StoryStudio's UI but a live execution never reads it back
   to decide anything.
2. **Regeneration bypassing QM.** If the Docker Rework agent calls Replicate/KIE/RunPod
   directly rather than through `qm-generate`, it reintroduces exactly the problem already
   found and *not* replicated in `narration-premium-rework-agent` (which does call
   `E2E-generate-images`/`E2E-generate-i2v` directly, bypassing the admission gate and
   capacity manager — a known issue in that agent, not a pattern to repeat here). **Resolved
   by construction, not just policy** — see §4.3.

### 4.3 Recommended hybrid: Docker/MCP agent is a pure evaluator + prompt-author — it never touches generation

The Docker/MCP service (however it's deployed) does exactly two things: **(a)** evaluate an
asset against the rule store + VLM reasoning and return pass/fail + issues, and **(b)**
author a corrected prompt when it fails. It returns *data* to Step Functions. Step Functions
then runs the actual regeneration itself, as the same native `qm-generate` Tasks already
built and deployed for Dialogue-Basic-QM-New (`QMReworkImageT2I`/`QMReworkVideo`,
`jobType: 'realtime'`).

This is a stronger safety property than "the agent is supposed to call qm-generate" — the
Docker/MCP agent never holds a credential or code path to any generation provider at all, so
it is *structurally* incapable of bypassing QM, not just trusted not to. It also gets the
genuine benefit Option B was reaching for (richer, stateful, multi-turn reasoning for
detection and prompt-authoring — the actual quality-of-judgment problem) without touching
the actual money-spending step.

```
        ┌───────────────────────────────────────────────────────────┐
        │        Docker + MCP: agent.ai-storystudio.com (or          │
        │        mcp.ai-storystudio.com extended)                     │
        │  ┌─────────────┐        ┌─────────────┐                    │
        │  │  DIRECTOR    │        │   QUALITY /  │   reads/writes    │
        │  │ (enrich      │        │   REWORK     │──▶ rule store     │
        │  │  prompt)     │        │ (detect +    │    (S3, §5)       │
        │  │              │        │  author fix) │                    │
        │  └──────┬──────┘        └──────┬──────┘                    │
        │         │  data only (prompt text, pass/fail, issues)       │
        └─────────┼────────────────────────┼──────────────────────────┘
                   │  http:invoke or Lambda adapter (SFN can't speak MCP)
                   ▼                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │             Step Functions (single source of truth)          │
        │  owns ALL qm-generate calls — image gen, video gen, rework   │
        │  regen. Docker/MCP agent never has a path to a provider.     │
        │  .waitForTaskToken if the agent's own reasoning is slow      │
        │  enough to need an async resume rather than a sync call.     │
        └─────────────────────────────────────────────────────────────┘
```

**Mechanics:** Step Functions has no native MCP client, so the Docker service needs a plain
HTTPS endpoint alongside whatever MCP surface it exposes to other consumers (e.g. a future
human-in-the-loop review tool, or a Claude-based session doing ad hoc project review) — call
it via Step Functions' native `http:invoke` Task (no Lambda adapter needed if the endpoint's
auth is simple enough for SFN's built-in HTTP task, e.g. an API key header) or a thin Lambda
adapter if it isn't. For "wait until the agent's response is ready," reuse
`.waitForTaskToken` — already proven in this exact codebase for
`QMGenerateInfiniteTalkRunpod` (SFN pauses, the external process finishes, a webhook resumes
it) — rather than inventing a poll loop.

**Where Docker/MCP earns its cost over Lambda:** the cross-scene, whole-project consistency
capability flagged as Option A's real gap (§4.1) — "this character's jacket must match
across all 18 scenes" needs to hold every scene's context in one reasoning session, which is
a genuinely different shape of work than per-scene classify-and-return. If that capability
is a near-term priority, Director is the natural first candidate to run this way (it already
needs project-wide rule context); Quality/Rework's per-scene gates can stay Lambda-inline
indefinitely — there's no forcing function to move them off Lambda unless per-scene
reasoning quality turns out to be the bottleneck, not deployment target.

---

## 5. Rule store data model (adapted from `storyframe_qa_agent/rule_store.py`)

```json
{
  "lastUpdated": "2026-08-10T19:40:00Z",
  "totalActiveRules": 4,
  "rules": [
    {
      "ruleId": "QAR-hallucination-visual-a50db6",
      "projectType": "dialogueBasic",
      "createdByAudit": "a50db6bc",
      "createdAt": "2026-08-10T19:12:00Z",
      "category": "HALLUCINATION_VISUAL",
      "trigger": "characters_present.length == 1",
      "action": "append_to_image_prompt",
      "value": "ONLY [character_name] in frame. No other human figures, faces, or silhouettes.",
      "appendToNegative": "extra people, duplicate character, mirrored figure, cloned body",
      "status": "active",
      "effectiveness": { "appliedCount": 0, "defectPreventedCount": 0, "successRate": 0.0 }
    }
  ]
}
```

Two changes from the `storyframe_qa_agent` original, both needed for QM specifically:

- **`projectType` on every rule**, and the store keyed/prefixed per tier
  (`qa_rule_store_dialogue_basic.json`, `qa_rule_store_narration_premium.json`, ...) —
  dialogue-basic's silent-scene rules (no narration/lip-movement concept) must not leak
  into narration-premium's rubric or vice versa.
- **Cross-project recurrence, not just within-project.** `generate_recommendations()`
  today only looks at ≥20% of *one project's* frames. A pattern that shows up in 5% of
  every project is real and worth a rule, but invisible to that threshold. Widen this by
  accumulating category counts across the last N audits (stored alongside the rule store,
  or queried from the existing `qa_reports_dialogue_basic/{project}/index.json` per-project
  indexes `s3_persistence.py` already writes) before deciding whether to promote a rule.

---

## 6. Phasing

1. **Move Gate 1 (image) inline**, before `QMGenerateSceneVideo`, reusing
   `image_evaluator.py` unchanged. Immediate win: stop paying for i2v on images already
   known bad. No rule store yet — pure move-the-check-earlier. Lambda, per §4.1/§4.3 (no
   deployment-target decision blocks this phase).
2. **Move Gate 2 (video) inline**, before `BuildSceneResult`, reusing `video_evaluator.py`
   unchanged, superseding the single post-hoc pass built 2026-08-10. Lambda, same as above.
3. **Stand up the rule store** (`rule_store.py` port, dialogue-basic-scoped) and wire
   `generate_recommendations()`/`persist_fix_rules()` into `dialogue-basic-qa-agent`'s
   existing end-of-run path (same place `storyframe_qa_agent` calls it).
4. **Build the Director** (`apply_qa_learned_rules`-equivalent) as a Task ahead of
   `RouteSceneImageGen`, reading the same store. Start Lambda; this is the specific
   component flagged in §4.3 as the natural first candidate to move to Docker/MCP once
   cross-scene whole-project consistency reasoning is wanted — not a blocker for shipping
   it in Lambda form first.
5. **Prove the loop**: track `HALLUCINATION_VISUAL` (and other category) rates per project
   over time — the metric that actually answers "does analysing more reduce recurrence,"
   not just "did this one project pass."
6. **If/when Docker+MCP is greenlit** (§4.2/§4.3): stand up the HTTPS endpoint alongside
   whatever MCP tools are exposed, wire it into Step Functions via `http:invoke` or a thin
   Lambda adapter, confirm it returns data only (no generation capability granted to it —
   no provider credentials, no `qm-generate` invoke permission), and migrate Director's
   Task to call it instead of the Lambda rule-matcher. Quality/Rework's per-scene gates
   (phases 1–2) stay Lambda-inline unless per-scene reasoning quality proves to be the
   actual bottleneck.

Each phase is independently shippable and testable against the same real project
(`js7bd2ep1edm9d4zqxvkg6sz458c6cg5`) already used to validate Gate 1/2's underlying
evaluators this session.

---

## 7. Open questions

- **Retire the post-hoc `QaAgentDialogueBasic` pass, or keep it as a final holistic
  check?** Depends on how good inline per-scene gating turns out to be at catching
  everything alone.
- **Rule store scope**: per-tier only, or shared base rules (anatomy/hallucination
  concepts are generic) + tier-specific overlays (narration's lip-movement rule doesn't
  apply to dialogue-basic)? `storyframe_qa_agent`'s `_RULE_DEFINITIONS` map is entirely
  category-keyed with no tier awareness today — worth deciding before porting.
- **Who owns rule review?** `retire_underperforming_rules()` auto-retires; should new
  rules also require a human glance before going live, or fully auto-promote like the
  existing prototype does?
- **Is `agent.ai-storystudio.com` a planned new domain, or shorthand for extending
  `mcp.ai-storystudio.com`/`storystudio-agent-mcp`?** Materially affects whether Docker/MCP
  work (§4.2/§4.3) starts from the existing Lambda-fronted MCP server or is greenfield
  infrastructure (new VPS, new domain/cert, new deploy pipeline).
- **Does Director actually need cross-scene reasoning in the near term**, or is per-scene
  rule-matching (Lambda, §3.1) sufficient for now? This is the one thing that would justify
  moving it to Docker/MCP ahead of Quality/Rework (§4.3) — worth confirming the need is real
  before taking on VPS operational cost (uptime, scaling, patching, auth/rate-limiting
  outside AWS's IAM boundary) for it.
