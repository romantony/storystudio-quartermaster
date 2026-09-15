/**
 * Contract extraction (prompt harness plan §4, §6.1). Only called when the
 * request doesn't already carry `frames[].shot` — one GPT-5 mini call per
 * frame, JSON-schema output, filling the ShotContract from
 * imagePrompt + motionPrompt + narration + the previous frame's contract
 * (for sceneId/continuity). Extraction never invents defaults for a field
 * it can't determine — the caller (harness/index.ts) treats a failed parse
 * as `harness_error` and falls back to the caller's original prompts,
 * never a guessed contract silently driving the rest of the pipeline.
 */
import { ShotContractSchema, type ShotContract } from '../contract';
import { runReplicateText, extractJson, type ReplicateDeps } from '../../quality/replicate';
import { log } from '../../telemetry/log';

export interface ExtractInput {
  frameId: string;
  imagePrompt: string;
  motionPrompt?: string;
  narration?: string;
  referenceImage: boolean;
  previous?: ShotContract;
}

const EXTRACT_SYSTEM = `You extract a structured SHOT CONTRACT from an image prompt, a motion prompt, and narration for one frame of a video.
Return JSON only, matching exactly this shape:
{
  "frameId": string,
  "sceneId": string,               // same location + continuous time as the previous frame -> reuse its sceneId; a new scene -> a new short id
  "setting": { "place": string, "population": "empty"|"sparse"|"crowd", "timeOfDay"?: string, "lighting"?: string },
  "subjects": [ { "id": string, "kind": "character"|"animal"|"prop", "count": number, "ref"?: "reference_image", "position": "left_third"|"center"|"right_third"|"foreground"|"background", "facing"?: "camera"|"away"|"screen_left"|"screen_right"|"three_quarter_left"|"three_quarter_right", "pose"?: string, "handContact"?: boolean, "detail"?: string } ],
  "camera": { "shotSize": "extreme_close_up"|"close_up"|"medium_close_up"|"medium"|"medium_wide"|"wide"|"extreme_wide", "angle": "eye_level"|"low_angle"|"high_angle"|"overhead"|"over_the_shoulder"|"first_person"|"aerial", "side": "front"|"back"|"left_profile"|"right_profile", "move": "static"|"push_in"|"pull_out"|"zoom_in"|"zoom_out"|"pan_left"|"pan_right"|"truck_left"|"truck_right"|"tilt_up"|"tilt_down"|"pedestal_up"|"pedestal_down"|"arc"|"tracking"|"handheld", "speed": "slow"|"medium", "essential": boolean },
  "action": { "subjectId": string, "verb": string, "screenDirection": "toward_camera"|"away_from_camera"|"screen_left"|"screen_right"|"up"|"down"|"none", "motionLevel": "low"|"medium"|"high", "ambient": string[] },
  "transformation": "none"|"continuation"|"state_change",
  "vfx": boolean
}
Rules:
- The FIRST subject in the array is always the primary/main character.
- Every subject that is countable (people, animals, distinct props) MUST have an accurate "count".
- "essential" is true only if the story genuinely requires this exact camera move and cannot be simplified.
- "transformation" is "state_change" only for an appear/vanish/transform/global-lighting-change; "continuation" if the image already shows the mid-state and the clip continues it; otherwise "none".
- Infer facing/side/screenDirection consistently: someone moving away from the camera faces away and is filmed from behind.
Return ONLY the JSON object, no prose.`;

function buildUserMessage(input: ExtractInput): string {
  return [
    `Frame id: ${input.frameId}`,
    `Reference image used: ${input.referenceImage ? 'yes' : 'no'}`,
    `Image prompt: ${input.imagePrompt}`,
    input.motionPrompt ? `Motion prompt: ${input.motionPrompt}` : '',
    input.narration ? `Narration: ${input.narration}` : '',
    input.previous ? `Previous frame's contract (for scene continuity):\n${JSON.stringify(input.previous)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function extractContract(
  deps: ReplicateDeps,
  cfg: { model: string; reasoningEffort: string },
  input: ExtractInput,
): Promise<ShotContract | undefined> {
  try {
    const text = await runReplicateText(deps, cfg.model, {
      system_prompt: EXTRACT_SYSTEM,
      prompt: buildUserMessage(input),
      reasoning_effort: cfg.reasoningEffort,
      verbosity: 'low',
      max_completion_tokens: 4000,
    });
    const json = extractJson(text) as Record<string, unknown>;
    if (!json.frameId) json.frameId = input.frameId;
    const parsed = ShotContractSchema.safeParse(json);
    if (!parsed.success) {
      log().warn({ frameId: input.frameId, issues: parsed.error.issues.slice(0, 5) }, 'harness: contract extraction failed validation');
      return undefined;
    }
    return parsed.data;
  } catch (err) {
    log().warn({ frameId: input.frameId, err }, 'harness: contract extraction call failed');
    return undefined;
  }
}
