/** Seed video guardrails for the wan2-lightning profile (prompt harness plan §5.2). See harness/guardrails/store.ts for how the replicate-wan22-fast profile derives from this set. */
import type { Guardrail } from '../types';

export const VIDEO_WAN2_LIGHTNING_GUARDRAILS: Guardrail[] = [
  {
    "id": "V-CAM-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Exactly one camera move per clip, stated first",
    "detector": {
      "type": "contract",
      "check": "oneMoveStated"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "keep_primary_move"
      }
    ],
    "instruction": "State exactly one camera move, at the start of the prompt.",
    "evidence": [
      "win_2026_09_15_06/f23: tilt + follow combined"
    ]
  },
  {
    "id": "V-CAM-02",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Camera move must be within the profile's capability",
    "detector": {
      "type": "contract",
      "check": "moveAllowedForProfile"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "downgrade_move"
      },
      {
        "type": "route",
        "to": "replicate-wan22-fast"
      }
    ],
    "instruction": "This camera move is banned or on probation for the 4-step Lightning profile \u2014 downgrade it, or route to the non-distilled model if the story marks it essential.",
    "evidence": [
      "win_2026_09_15_06/f21: crane up -> static x3; f18/f22: tracking marginal/reversed"
    ]
  },
  {
    "id": "V-CAM-03",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Camera angle, side and shot size are locked to the image",
    "detector": {
      "type": "contract",
      "check": "cameraLockedToImage"
    },
    "fixTarget": "image_prompt",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "align_facing"
      }
    ],
    "instruction": "The clip starts from a fixed source image \u2014 never imply a change of camera side, angle or shot size (\"from behind\" on a front-facing image, \"rises above\").",
    "evidence": [
      "win_2026_09_15_06/f18: reversed camera side"
    ]
  },
  {
    "id": "V-CAM-04",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Speed adverb present; never fast/rapid",
    "detector": {
      "type": "contract",
      "check": "speedIsSlowOrMedium"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "slow_down"
      }
    ],
    "instruction": "Use \"slow\" or \"gentle\"; never \"fast\", \"rapid\", or \"whip\" \u2014 cfg 1.0 has no real guidance to hold a fast move together.",
    "evidence": [
      "qm-orchestrator-wan2-cfg-rungs: Lightning runs at cfg 1.0"
    ]
  },
  {
    "id": "V-CAM-05",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "No reveal moves that need off-frame content",
    "detector": {
      "type": "lexicon",
      "list": "reveal",
      "field": "motionPrompt"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "static_wide_from_image"
      }
    ],
    "instruction": "Do not ask the camera to \"reveal\" content that is not already in the source frame \u2014 put that content in the image instead and hold a wide static shot.",
    "evidence": [
      "win_2026_09_15_06/f21: 'revealing the station above her' -> static"
    ]
  },
  {
    "id": "V-DIR-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Movement direction expressed in screen space",
    "detector": {
      "type": "lexicon",
      "list": "relativeDirection",
      "field": "motionPrompt"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "noop_compile_leads"
      }
    ],
    "instruction": "Describe movement in screen-space terms only: toward the camera, away from the camera, screen-left, screen-right \u2014 never \"forward\", \"past\", \"behind her\", \"ahead\".",
    "evidence": [
      "win_2026_09_15_06/f18"
    ]
  },
  {
    "id": "V-DIR-02",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Direction is consistent with facing and camera side",
    "detector": {
      "type": "contract",
      "check": "directionConsistent"
    },
    "fixTarget": "image_prompt",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "align_facing"
      }
    ],
    "instruction": "The action's screen direction, the subject's facing, and the camera's side must agree \u2014 a subject facing away moves away from the camera, one facing the camera moves toward it.",
    "evidence": [
      "win_2026_09_15_06/f18: reversed"
    ]
  },
  {
    "id": "V-DIR-03",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Direction lock clause present",
    "detector": {
      "type": "contract",
      "check": "lockClausePresent"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "noop_compile_leads"
      }
    ],
    "instruction": "End with a lock sentence restating facing, screen direction and camera angle, so the model does not drift mid-clip.",
    "evidence": [
      "prompt harness plan \u00a77 direction/angle lock"
    ]
  },
  {
    "id": "V-DIR-04",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Cross-frame direction/side continuity within a scene",
    "detector": {
      "type": "continuity",
      "check": "sceneDirectionConsistent"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "keep_scene_direction"
      }
    ],
    "instruction": "Within the same scene, keep screen direction and camera side the same across frames unless the contract marks a deliberate direction change.",
    "evidence": [
      "user requirement: hold direction across a scene"
    ]
  },
  {
    "id": "V-ACT-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "One primary action; other motion is ambient only",
    "detector": {
      "type": "contract",
      "check": "oneActionStated"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "keep_primary_action"
      }
    ],
    "instruction": "State exactly one primary action for the subject. Other motion (dust, light, hair, cloth, water) is ambient only.",
    "evidence": [
      "Movie Gen \u00a73.4.1: elaborate motion detail introduces artifacts"
    ]
  },
  {
    "id": "V-ACT-02",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "No state change within a clip",
    "detector": {
      "type": "contract",
      "check": "noStateChange"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "continuation_beat"
      },
      {
        "type": "split_shot"
      }
    ],
    "instruction": "A clip may show a continuation of a mid-state already visible in the image, never an appear/vanish/transform or a global lighting change from one state to another.",
    "evidence": [
      "win_2026_09_15_06/f20 fail vs f09/f11/f15/f36 pass; Movie Gen \u00a78"
    ]
  },
  {
    "id": "V-ACT-03",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "motionLevel high is not allowed on Lightning",
    "detector": {
      "type": "contract",
      "check": "motionLevelAllowed"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "downgrade_motion_level"
      }
    ],
    "instruction": "Downgrade a high-motion verb to medium (sprint -> run, lunge -> step), or route to the non-distilled model.",
    "evidence": [
      "Movie Gen motion-level tags; qm-video-conformity-prompt-testing"
    ]
  },
  {
    "id": "V-HAL-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "Motion prompt mentions only subjects present in the image contract",
    "detector": {
      "type": "contract",
      "check": "noHallucinatedSubjects"
    },
    "fixTarget": "motion_prompt",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "drop_missing_subject_reference"
      }
    ],
    "instruction": "Only mention subjects that are in the image's contract. No new people, animals, or props may enter mid-clip.",
    "evidence": [
      "2026-08-15 missing-kitten hallucination; win_2026_09_15_06/f19"
    ]
  },
  {
    "id": "V-HAL-02",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Public/sparse settings: restrict move and state the only-person clause",
    "detector": {
      "type": "contract",
      "check": "populationHallucinationGuard"
    },
    "fixTarget": "contract",
    "corrective": [
      {
        "type": "contract_edit",
        "edit": "downgrade_move"
      }
    ],
    "instruction": "In a public or sparse setting, keep the move to static or push-in and add \"she stays the only person in the scene\" \u2014 pans/trucks/pull-outs expose frame edges where extras spawn.",
    "evidence": [
      "win_2026_09_15_06/f19: stranger walks in during a push-in on an unmarked platform"
    ]
  },
  {
    "id": "V-LEN-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Motion prompt length band",
    "detector": {
      "type": "contract",
      "check": "motionLengthOk"
    },
    "fixTarget": "motion_prompt",
    "corrective": [
      {
        "type": "regenerate",
        "instruction": "Fit the motion prompt between 12 and 45 words without dropping the lock clause."
      }
    ],
    "instruction": "12 to 45 words.",
    "evidence": [
      "Movie Gen \u00a73.4.1; 2026-08-14 LightX2V structured-prompt test"
    ]
  },
  {
    "id": "V-LEX-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "fix",
    "title": "Plain verbs, present tense, no metaphor",
    "detector": {
      "type": "lexicon",
      "list": "metaphor",
      "field": "motionPrompt"
    },
    "fixTarget": "motion_prompt",
    "corrective": [
      {
        "type": "regenerate",
        "instruction": "Replace metaphorical or abstract language with plain, literal, present-tense description."
      }
    ],
    "instruction": "Plain verbs, present tense \u2014 no metaphor or abstract adjectives (\"impossible architecture towers above\").",
    "evidence": [
      "Movie Gen \u00a73.4.1"
    ]
  },
  {
    "id": "V-NEG-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "No negated defects; no (avoid:) suffix",
    "detector": {
      "type": "lexicon",
      "list": "negation",
      "field": "motionPrompt"
    },
    "fixTarget": "motion_prompt",
    "corrective": [
      {
        "type": "regenerate",
        "instruction": "Strip every (avoid: ...) clause and every \"no\"/\"without\" defect phrase; state the fix positively."
      }
    ],
    "instruction": "No \"avoid\"/\"no\"/\"without\" + defect, and no (avoid: ...) suffix.",
    "evidence": [
      "win_2026_09_15_06/f18-f20 stacked (avoid:) clauses"
    ]
  },
  {
    "id": "V-REW-01",
    "domain": "video",
    "profile": "wan2-lightning",
    "version": 1,
    "status": "active",
    "severity": "block",
    "title": "A regenerated motion prompt adds no new nouns or verbs",
    "detector": {
      "type": "contract",
      "check": "noInventedNouns"
    },
    "fixTarget": "motion_prompt",
    "corrective": [],
    "instruction": "Do not add any noun, motion verb, number, or unit beyond the contract and the draft.",
    "evidence": [
      "GPT-5 mini rewrite invented detail"
    ]
  }
] as Guardrail[];
