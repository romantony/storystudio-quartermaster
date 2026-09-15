/** Seed image guardrails (prompt harness plan §5.1). Git-tracked, hand-authored from the win_2026_09_15_06 (Maya) cohort findings — see docs/qm-orchestrator-prompt-harness-implementation-plan.md. */
import type { Guardrail } from '../types';

export const IMAGE_GUARDRAILS: Guardrail[] = [
  {
    "id": "I-CNT-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Every countable subject/prop carries an explicit count",
    "detector": {
      "type": "contract",
      "check": "countsExplicit"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "render_counts"
      }
    ],
    "instruction": "State the exact count of every subject and prop as a positive constraint, e.g. \"one glowing crystal\".",
    "evidence": [
      "win_2026_09_15_06/f12: 3 crystals instead of 1"
    ]
  },
  {
    "id": "I-CNT-02",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "A single-character shot states \"one [character], alone in frame\"",
    "detector": {
      "type": "contract",
      "check": "singleCharacterAlone"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "render_counts"
      }
    ],
    "instruction": "If exactly one character is in the shot, say so explicitly: \"one girl, alone in frame\".",
    "evidence": [
      "win_2026_09_15_06/f12: 2 identical girls"
    ]
  },
  {
    "id": "I-SUB-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Every secondary subject is grounded with appearance and position",
    "detector": {
      "type": "contract",
      "check": "secondarySubjectsGrounded"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "ground_secondary"
      },
      {
        "type": "regenerate",
        "instruction": "Ground every secondary subject with explicit appearance and position; never introduce one as a bare trailing mention."
      }
    ],
    "instruction": "Give every secondary/background subject the same visual and spatial grounding as the primary subject \u2014 never a bare trailing mention.",
    "evidence": [
      "2026-08-15 missing-kitten hallucination"
    ]
  },
  {
    "id": "I-HAND-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Hand contact at close range is routed wider or to Flux-4B",
    "detector": {
      "type": "contract",
      "check": "handContactRisk"
    },
    "fixTarget": "route",
    "corrective": [
      {
        "type": "route",
        "to": "flux-4b"
      },
      {
        "type": "contract_edit",
        "edit": "widen_shot"
      }
    ],
    "instruction": "Hand contact (pressing, touching, gripping a surface) at close range is a known Qwen failure mode \u2014 widen the shot or route to Flux-4B with the reference image.",
    "evidence": [
      "win_2026_09_15_06/f13: duplicated hands x3"
    ]
  },
  {
    "id": "I-DIR-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Primary character facing is stated in screen terms and matches the video contract",
    "detector": {
      "type": "contract",
      "check": "facingConsistentWithAction"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "derive_facing_from_motion"
      }
    ],
    "instruction": "State the primary character's facing in screen terms (camera / away / screen-left / screen-right / three-quarter) and keep it consistent with the planned camera side and screen direction.",
    "evidence": [
      "win_2026_09_15_06/f18: camera side reversed"
    ]
  },
  {
    "id": "I-ANG-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Shot size and camera angle stated at the start of the prompt",
    "detector": {
      "type": "contract",
      "check": "shotSizeAngleAtStart"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "noop_compile_leads"
      }
    ],
    "instruction": "Lead the prompt with shot size and camera angle, matching the contract exactly.",
    "evidence": [
      "Movie Gen \u00a73.4.1 standardized information architecture"
    ]
  },
  {
    "id": "I-SIDE-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Camera side is explicit when the action needs it",
    "detector": {
      "type": "contract",
      "check": "cameraSideExplicitWhenNeeded"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "derive_facing_from_motion"
      }
    ],
    "instruction": "For a walking/running/turning action, state which side the camera is on (\"seen from behind\", \"right profile, facing screen-right\").",
    "evidence": [
      "win_2026_09_15_06/f18"
    ]
  },
  {
    "id": "I-EMP-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Public settings declare population",
    "detector": {
      "type": "contract",
      "check": "populationDeclaredInPublicPlace"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "population_empty"
      }
    ],
    "instruction": "In a public setting (street, platform, corridor), state population explicitly, e.g. \"an empty platform, she is the only person there\".",
    "evidence": [
      "win_2026_09_15_06/f19: stranger walks in"
    ]
  },
  {
    "id": "I-LEAD-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Lead room for the planned direction of travel",
    "detector": {
      "type": "contract",
      "check": "leadRoomOk"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "lead_room"
      }
    ],
    "instruction": "Place a subject that will move screen-left/right on the opposite third of the frame, with open space in the direction of travel.",
    "evidence": [
      "prompt harness plan \u00a77 direction-lock support"
    ]
  },
  {
    "id": "I-REFL-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "probation",
    "severity": "warn",
    "title": "Avoid a character close to and facing a wall/mirror/window/glass",
    "detector": {
      "type": "contract",
      "check": "closeFacingReflectiveSurface"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "three_quarter_facing"
      }
    ],
    "instruction": "Prefer a three-quarter facing over a character close to and directly facing a wall, mirror, window or glass surface.",
    "evidence": [
      "win_2026_09_15_06/f12 hypothesis (unproven)"
    ]
  },
  {
    "id": "I-TRANS-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "A state transformation is shown as its visible mid-state",
    "detector": {
      "type": "lexicon",
      "list": "vanishTransform",
      "field": "imagePrompt"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "continuation_beat"
      }
    ],
    "instruction": "Show a state transformation as its visible mid-state (half through the wall, hand already in the tiles) \u2014 never as \"disappearing\" or \"turning into\".",
    "evidence": [
      "win_2026_09_15_06: f09/f11/f15/f36 (mid-state) passed, f20 (disappear) failed"
    ]
  },
  {
    "id": "I-REF-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Reference-image anchor appears exactly once",
    "detector": {
      "type": "contract",
      "check": "referenceAnchorOnce"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "noop_compile_leads"
      }
    ],
    "instruction": "Keep \"the girl from the reference image\" (or equivalent) exactly once when a reference image is used.",
    "evidence": [
      "existing convention, steps/builders/image-edit.ts"
    ]
  },
  {
    "id": "I-LEN-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "warn",
    "title": "Image prompt length cap",
    "detector": {
      "type": "contract",
      "check": "imageLengthOk"
    },
    "fixTarget": "image_prompt",
    "corrective": [
      {
        "type": "regenerate",
        "instruction": "Shorten to at most 110 words without dropping any contract detail."
      }
    ],
    "instruction": "At most 110 words, one moment in one location.",
    "evidence": [
      "quality/rewrite.ts's existing IMAGE_SYSTEM cap"
    ]
  },
  {
    "id": "I-NEG-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "No negated defects in the positive prompt",
    "detector": {
      "type": "lexicon",
      "list": "negation",
      "field": "imagePrompt"
    },
    "fixTarget": "image_prompt",
    "corrective": [
      {
        "type": "regenerate",
        "instruction": "Remove every \"avoid\"/\"no\"/\"without\" clause; state the fix as a positive constraint instead."
      }
    ],
    "instruction": "Never write \"avoid\", \"no\", \"without\", or \"not\" followed by a defect \u2014 diffusion models render nouns they are given.",
    "evidence": [
      "win_2026_09_15_06: (avoid:) suffix stacking on f18-f20"
    ]
  },
  {
    "id": "I-REW-01",
    "domain": "image",
    "profile": "any",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "A regenerated prompt adds no new nouns beyond the contract",
    "detector": {
      "type": "contract",
      "check": "noInventedNouns"
    },
    "fixTarget": "image_prompt",
    "corrective": [],
    "instruction": "Do not add any subject, prop, body part, or measurement that is not already in the contract or draft.",
    "evidence": [
      "GPT-5 mini rewrite invented \"fingertips sinking 5-8mm\""
    ]
  }
] as Guardrail[];
