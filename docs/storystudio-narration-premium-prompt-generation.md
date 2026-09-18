# StoryStudio: generating Narration Premium prompts for the QM prompt harness

**Audience:** StoryStudio engineers building the Narration Premium request.
**Companion to:** `storystudio-orchestrator-integration.md` (the transport: auth, `POST /v1/requests`,
cohorts, the result callback). This document covers only one thing — **what to put in each frame, and
how to have an LLM produce it** — for the video model QM actually runs: self-hosted Wan 2.2
I2V-A14B, LightX2V 4-step Lightning distillation, 480p.

---

## 1. The short version

Stop writing the motion prompt. Write a **shot contract** instead, and let QM's prompt harness
compile the prompt.

```jsonc
// frames[] entry — Narration Premium
{
  "frameId": "f_004",
  "narration": "By the time she reached the corridor, the letter was already open.",
  "durationS": 5,
  "imagePrompt": "...",        // still required — fallback if the harness is off
  "motionPrompt": "...",       // still required — same reason
  "referenceImageUrl": "https://.../maya-reference.png",
  "shot": { /* the contract — section 4 */ }
}
```

`shot` is the part that matters. When it is present and valid, the harness compiles **both** the
image prompt and the motion prompt from it, deterministically, and the two are guaranteed to agree
with each other. When it is absent, QM runs a GPT-5 mini extraction pass over your free text to
reconstruct one — which works, but it is a guess at what you already knew.

**The one-line rationale:** every failure in the first production cohort was predictable from the
prompt text alone. A camera move the model cannot execute, a subject facing away while walking
toward the camera, a second person appearing on an "empty" platform, a transformation asked for
inside a single 5-second clip. A contract makes those checkable *before* generation instead of
detectable after it.

---

## 2. Why one contract produces two prompts

A Narration Premium frame is two generations, in order:

| Step | Model | Prompt |
|---|---|---|
| 0 — image | Qwen-Image-Edit, from `referenceImageUrl` | image prompt |
| 3 — animation | **Wan 2.2 I2V-A14B, 4-step Lightning, 480p** | motion prompt |

Step 3 animates step 0's output. It cannot move the camera to a different side of the subject, cannot
change the shot size, and cannot introduce anything not already in the pixels. So the camera side,
angle, shot size and the subject's facing are **decided once, in the image**, and the motion prompt
only restates them as a lock.

This is why the two prompts must come from one source. Written separately by an LLM, they drift — and
when they disagree, the image wins and the clip is wrong.

---

## 3. What to supply the LLM

Per frame, the LLM that produces the contract needs:

| Input | Why |
|---|---|
| `narration` for this frame | the beat being illustrated |
| the scene/beat text or storyboard note | what actually happens |
| `sceneId` | scene grouping — direction continuity is enforced within a scene (V-DIR-04) |
| **the previous frame's contract in the same scene** | so screen direction and camera side stay consistent across cuts |
| the character reference sheet / description | the subject `id` must be stable across every frame |
| `durationS` | a 3–7 s clip fits one beat, not three |
| the capability limits in section 6 | the LLM must not request a move the model cannot do |

Do **not** give the LLM freedom over: resolution, steps, seed, guidance, solver, or duration bounds.
Those are fixed (section 7).

---

## 4. The shot contract

Validated by `orchestrator/src/harness/contract.ts`. Unknown fields are rejected — the schema is
strict. Anything the LLM cannot determine should be **omitted**, never guessed: an omitted field is a
signal the harness knows how to fix, a wrong one is a defect it will faithfully render.

```jsonc
{
  "frameId": "f_004",
  "sceneId": "sc_02",

  "setting": {
    "place": "a hospital corridor at night",   // required
    "population": "empty",                     // "empty" | "sparse" | "crowd"
    "timeOfDay": "night",                      // optional
    "lighting": "cold overhead fluorescent light" // optional
  },

  "subjects": [                                 // at least one
    {
      "id": "Maya",                             // stable across ALL frames
      "kind": "character",                      // "character" | "animal" | "prop"
      "count": 1,                               // count explicitly — always
      "ref": "reference_image",                 // set on the character carried by referenceImageUrl
      "position": "center",                     // left_third | center | right_third | foreground | background
      "facing": "camera",                       // camera | away | screen_left | screen_right
                                                //   | three_quarter_left | three_quarter_right
      "pose": "standing, holding a folded letter",
      "handContact": false,                     // true if hands touch another subject or object. In a
                                                //   close shot this routes the image to a stronger
                                                //   model — hands in contact are the #1 image defect
      "detail": "..."                           // required in practice for every subject after the first
    }
  ],

  "camera": {
    "shotSize": "medium",       // extreme_close_up | close_up | medium_close_up | medium
                                //   | medium_wide | wide | extreme_wide
    "angle": "eye_level",       // eye_level | low_angle | high_angle | overhead
                                //   | over_the_shoulder | first_person | aerial
    "side": "front",            // front | back | left_profile | right_profile
    "move": "push_in",          // ONE move — see the capability table, section 6
    "speed": "slow",            // "slow" | "medium"  (default "slow")
    "essential": false          // true = the story genuinely needs this move; a move the
                                //   4-step model can't do is then routed to a stronger
                                //   model instead of being silently downgraded
  },

  "action": {
    "subjectId": "Maya",                        // must match a subjects[].id
    "verb": "looks down at the letter and slowly lowers it",  // ONE primary action
    "screenDirection": "none",                  // toward_camera | away_from_camera | screen_left
                                                //   | screen_right | up | down | none
    "motionLevel": "low",                       // "low" | "medium" | "high"
    "ambient": ["the fluorescent light flickers faintly"]     // max 2 are used
  },

  "transformation": "none",     // "none" | "continuation" | "state_change"
  "vfx": false
}
```

### Field notes that actually bite

- **`subjects[].count` is not optional in spirit.** "one glowing crystal" renders one crystal;
  "the crystal beside her" rendered three.
- **`screenDirection` is screen space, never story space.** `toward_camera`, `screen_left`. Never
  "forward", "past her", "behind her" — those have no fixed meaning to the model and get rendered as
  the opposite roughly half the time.
- **`facing` and `screenDirection` must agree with `camera.side`.** A subject `facing: "away"` moves
  `away_from_camera`. Asking a front-facing subject to walk away from camera is a contradiction the
  harness resolves by changing the **image**, because I2V cannot rotate the camera.
- **`transformation: "state_change"` is a request the 4-step model will not honour.** Appear, vanish,
  transform, dissolve, "the lights go out". Write the *midpoint* as a `continuation` instead ("half
  through the wall", "the light already fading"). If you genuinely need the change, split it into two
  frames yourself — QM flags it (`splitShot`) but still submits a single best-effort clip.
- **`ambient` is where secondary motion goes.** Dust, hair, cloth, water, background light. One
  primary action per clip; everything else is ambient.

---

## 5. The LLM prompt that produces the contract

### 5.1 System prompt

```text
You convert one storyboard beat into a SHOT CONTRACT: a strict JSON object describing a single
5-second image-to-video shot. You do not write prose prompts. Another system compiles your JSON
into the actual image and video prompts.

Output ONLY the JSON object. No markdown fence, no commentary.

The video model is Wan 2.2 image-to-video, 4-step distilled, 480p, 3-7 seconds. It animates ONE
still image. It cannot move the camera to another side of the subject, cannot change shot size
mid-clip, and cannot add anything that is not already in the still.

RULES

1. ONE camera move per shot. Prefer "static" or "push_in"; both are reliable. "pull_out", "zoom_in",
   "zoom_out", "pan_left", "pan_right", "truck_left", "truck_right", "tilt_up" and "tilt_down" are
   unreliable — use one only when the beat truly needs it. NEVER use "arc", "tracking", "handheld",
   "pedestal_up" or "pedestal_down".
2. ONE primary action in action.verb. All other movement goes in action.ambient.
3. Screen-space direction only: toward_camera, away_from_camera, screen_left, screen_right, up,
   down, none. Never "forward", "past", "behind", "ahead".
4. action.screenDirection, the acting subject's facing, and camera.side must be mutually consistent.
   A subject facing away moves away_from_camera; a subject facing the camera moves toward_camera.
5. No state change inside one shot — nothing appears, vanishes, transforms, or switches a global
   lighting state. Describe the midpoint of the change as an ongoing continuation instead.
6. motionLevel "low" or "medium". Use "high" only for genuinely large body motion (running,
   fighting, dancing); it will be downgraded, so prefer to re-frame the beat as a smaller action.
7. Count every subject explicitly with subjects[].count.
8. In a public place where nobody else should appear, set setting.population to "empty".
9. Never write negations, "avoid", "no ...", or defect words anywhere. State what IS true.
10. Keep subjects[].id identical for the same character in every frame of the project.
11. Omit any optional field you cannot determine from the input. Do not invent detail that is not in
    the beat, the narration, or the character description.
12. Within one scene, keep screenDirection and camera.side consistent with the previous shot unless
    the beat is a deliberate direction change.

SCHEMA
<paste the section 4 schema here>
```

### 5.2 User message template

```text
PROJECT CHARACTER
  id: Maya
  description: <the reference sheet text — the same text used to generate referenceImageUrl>

SCENE
  sceneId: sc_02
  summary: <what happens in this scene>

PREVIOUS SHOT IN THIS SCENE (for continuity; null if this is the first)
  <the previous frame's contract JSON, or null>

THIS BEAT
  frameId: f_004
  durationS: 5
  narration: "By the time she reached the corridor, the letter was already open."
  storyboard note: <the beat description, if you have one>

Return the shot contract JSON for this beat.
```

### 5.3 Validate before sending

Parse the LLM output and check it yourself. A malformed `shot` is silently ignored by QM (it falls
back to extraction), so a schema break shows up as "the harness didn't use my contract" rather than
as an error. Minimum checks: it parses; `action.subjectId` matches a `subjects[].id`; every enum
value is in range; `camera.move` is not one of the five banned moves.

You can dry-run a whole request through the harness without generating anything:

```
POST /v1/harness/lint      # returns the compiled prompts + every rule violation, per frame
```

Use it in CI against a few representative storyboards. It costs nothing and catches the entire class
of failure this document exists to prevent.

---

## 6. What the 4-step model can and cannot do

### Camera moves

| Status | Moves | What the harness does |
|---|---|---|
| **Reliable** | `static`, `push_in` | used as-is |
| **Unreliable** | `pull_out`, `zoom_in`, `zoom_out`, `pan_left`, `pan_right`, `truck_left`, `truck_right`, `tilt_up`, `tilt_down` | **downgraded to `static`/`push_in` at plan time** |
| **Banned** | `pedestal_up`, `pedestal_down`, `arc`, `tracking`, `handheld` | same — downgraded to `static`/`push_in` |

Be aware of how blunt this is: in practice **only `static` and `push_in` ever reach the 4-step
model.** Everything else is downgraded before a frame is generated. The single escape hatch is
`camera.essential: true`, which suppresses the downgrade and instead routes that frame to the
non-distilled Replicate Wan 2.2 — slower and separately billed, so use it for shots that genuinely
carry story weight, not as a default.

Moves that expose frame edges (pans, trucks, pull-outs) are where extras spawn — a stranger once
walked into a push-in on an "unmarked" subway platform. The harness's defence is the only-person
clause it compiles into every motion prompt, which is why `setting.population` must be honest:
`empty` is what produces "she is the only person there" in the image prompt. If you are writing a
non-empty public setting, prefer `static` or `push_in` yourself.

### Motion levels

The contract has three levels. If you think in the five-class M0–M4 scale:

| M-class | Example | Contract `motionLevel` |
|---|---|---|
| M0 almost static | held pose, breathing | `low` |
| M1 subtle | head turn, eyes, hair, cloth | `low` |
| M2 moderate | walking, turning, gesturing | `medium` |
| M3 substantial | running, fighting, dancing | `high` → downgraded; split the beat instead |
| M4 extreme | jumping, explosions, choreography | not supported — must be split across frames |

Prefer M1–M2. For M3/M4, break the sequence into separate frames rather than asking one 5-second
clip to perform all of it:

```text
✗  Man stands, runs across the room, opens the door and gets into the car.

✓  f_011  Man rises quickly and turns toward the doorway.       (medium)
   f_012  Man runs screen-left down the hallway.                (medium)
   f_013  Man pulls the car door open.                          (medium)
```

### Fixed output shape

480p (832×464 after normalisation), 16 fps, **3–7 whole seconds**. Actual length follows the
generated narration audio, not your `durationS` estimate — `durationS` is used for scheduling.

---

## 7. Inference is locked, and why the usual Lightning numbers are wrong here

StoryStudio does not set generation parameters. They are pinned per versioned profile
(`orchestrator/src/harness/profiles/inference.ts`), currently `wan22-lightning-i2v-480p-v1`, and the
id is recorded on every clip so a quality finding is attributable to an exact configuration.

There is a trap worth stating explicitly, because public write-ups about "Wan 2.2 Lightning" get it
wrong for this deployment:

| Parameter | Generic Lightning-LoRA advice | **What our endpoint actually runs** |
|---|---|---|
| shift | 3.0 | **7.0** (480p I2V) |
| guidance | 1.0 | **3.5 / 3.5** (per high- and low-noise DiT) |
| CFG | "effectively disabled" | **genuinely disabled** — the unconditional branch is skipped, not zeroed |
| solver | Euler | **unipc** |
| LoRA strength | 1.0 / 1.0 | **no LoRA at all** — the distillation is baked into the FP8 weights |
| steps | 4 | 4 |

Those values were verified against LightX2V's own published `wan22` configs, and the worker
deliberately differs from the base-model defaults. Applying the generic numbers would de-calibrate a
worker that is already correct.

Two consequences for prompt writing:

1. **Negative prompts do nothing.** `n_prompt` is accepted for API compatibility and entirely
   ignored — with no unconditional branch there is nothing to steer away from. Put the constraint
   positively in the prompt ("her facial appearance stays consistent") and let QA catch the rest.
   The harness blocks negated phrasing outright (V-NEG-01), including the `(avoid: …)` suffix
   pattern, which measurably made results *worse*.
2. **There is no guidance to hold a fast move together.** Camera speed is `slow` or `medium`; "fast",
   "rapid" and "whip" are rejected.

### Seeds

Each frame gets a seed from a fixed bank, derived deterministically from `projectId` + `frameId`.
Two properties follow:

- **Reproducible** — re-submitting an identical request reproduces a *visually* identical clip.
  Not a bit-identical one: measured live, two same-seed runs differed by at most `18/255` in any
  single pixel (99th percentile `4/255`), which is imperceptible, but they are not byte-equal. The
  residue is GPU nondeterminism across workers, not the seed failing to take. Don't build anything
  on byte-equality of outputs.
- **A retry is guaranteed to sample differently**, because a reseed steps along the bank rather than
  re-rolling and hoping. For contrast, two *different* seeds differed by up to `233/255`, with 6% of
  pixels more than `8/255` apart — about 500× the same-seed residue at the tail.

The effective seed is echoed back by the worker, so even a clip generated before this existed can be
reproduced after the fact. Nothing for StoryStudio to send; this is listed so the behaviour is
predictable when you re-run a project and get the same output.

---

## 8. What happens after you send it

```text
frames[].shot
   │
   ├─ validate ──────────► invalid or absent: reconstruct from your free text (GPT-5 mini)
   │
   ├─ normalise           align facing/side with direction; add lead room; ground secondary
   │                      subjects; downgrade a move or motion level the profile can't do;
   │                      turn a state_change into a continuation beat
   │
   ├─ compile             image prompt + motion prompt, deterministically
   │
   ├─ lint (18 video + 15 image rules)
   │                      still-violating rules get a targeted fix, or route the frame to a
   │                      stronger model up front
   │
   ├─ generate            image → clip, at the pinned inference profile + bank seed
   │
   └─ QA gate             fail → corrective ladder, driven by the rule that failed:
                            · contract edit + recompile   (the targeted fix for that rule)
                            · model switch                (non-distilled Wan 2.2 on Replicate,
                                                           carrying the same seed — so the
                                                           attempt changes the model and
                                                           nothing else)
                            · prompt regeneration         (constrained: may add no new nouns)
                            · reseed                      (same prompt, next bank seed) — the
                                                           fallback when the rule has no
                                                           remaining measure, or the failure
                                                           didn't match a known rule
                            · accept + flag               (surfaced in the result callback)
```

The ladder is bounded — there is no unbounded retry loop. A frame that exhausts it is delivered and
flagged rather than blocking the project.

---

## 9. Worked example

Contract in (the section 4 example), and the prompts the harness compiles — **actual compiler
output**, not illustrative:

**Image prompt**

```text
Medium shot at eye level. cold overhead fluorescent light, night. one Maya, alone in frame from the
reference image standing, holding a folded letter. a hospital corridor at night, she is the only
person there. Photorealistic cinematic film still, 16:9, consistent character identity.
```

**Motion prompt** (43 words — the band is 12–45)

```text
Slow push in, medium at eye level. Maya, facing the camera, looks down at the letter and slowly
lowers it. the fluorescent light flickers faintly. Maya keeps facing the camera; the camera stays
eye level; Maya stays the only person in the scene.
```

Note the shape: camera first, one action, ambient, then a lock clause restating facing, angle and
subject count. Every clip in the project gets that same grammar — which is most of where the
consistency gain comes from.

### A contract the harness has to fix

An LLM that ignored the rules asks for a tracking shot of a subject running away on a sparse
platform:

```jsonc
"camera": { "shotSize": "wide", "angle": "eye_level", "side": "back",
            "move": "tracking", "speed": "medium" },
"action": { "verb": "runs", "screenDirection": "away_from_camera", "motionLevel": "high" }
```

Lint returns `V-CAM-02 (block)`, `V-CAM-03 (block)`, `V-ACT-03 (fix)`, and the compiled prompt
changes from

```text
Tracking shot, the camera following from behind, wide at eye level. Maya, facing away from the
camera, runs away from the camera. …
```

to

```text
Static camera, wide at eye level. Maya, facing away from the camera, runs away from the camera. …
```

— move `tracking → static`, motion level `high → medium`, speed `medium → slow`. The shot still gets
made. It is just no longer a shot the model was going to fail at. Had the beat genuinely required the
tracking move, `essential: true` would have routed it to the non-distilled model instead of
downgrading it.

---

## 10. Rollout

`options.promptHarness` controls how far the harness is allowed to go:

| Value | Behaviour |
|---|---|
| `off` | skipped entirely; your prompts are used verbatim |
| `lint` *(current default)* | full pipeline runs and records its output and findings, but **your** prompts are still what gets generated |
| `enforce` | the compiled prompts and bank seeds are what gets submitted |

**What to do now:** start sending `frames[].shot` while the default is still `lint`. Then compare
`harnessImagePrompt` / `harnessMotionPrompt` against what your own prompts produced on the same
cohort, and flip a project to `enforce` once you are satisfied. Sending `shot` in `lint` mode changes
nothing about your output — it only makes the comparison possible.

---

## 11. Checklist

- [ ] One `shot` per frame, schema-valid, strict (no extra keys).
- [ ] `subjects[].id` stable across every frame of the project.
- [ ] `count` set on every subject.
- [ ] `camera.move` not in {`arc`, `tracking`, `handheld`, `pedestal_up`, `pedestal_down`} unless
      `essential: true`.
- [ ] `facing` / `screenDirection` / `camera.side` mutually consistent.
- [ ] One primary `action.verb`; everything else in `ambient`.
- [ ] `transformation` is `none` or `continuation` — never `state_change` if you can split it.
- [ ] `population: "empty"` wherever no extras should appear.
- [ ] No negations, no "avoid", anywhere.
- [ ] Previous shot passed to the LLM for scene continuity.
- [ ] `POST /v1/harness/lint` clean on your representative storyboards.
