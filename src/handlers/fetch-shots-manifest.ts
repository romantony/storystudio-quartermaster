/**
 * QM-fetch-shots-manifest — Dialogue Premium only
 * (storystudio-dialogue-qm-sfn-handoff.md §7.2). A large film (60-90 shots,
 * long image prompts) can approach Step Functions' 256KB input limit;
 * StoryStudio then sends `shotsManifestUrl` (an R2 JSON URL) instead of
 * inlining `shots`. R2 isn't AWS S3, so the SFN's native
 * `aws-sdk:s3:getObject` integration can't fetch it directly — this is a
 * plain HTTPS GET + JSON parse, small enough not to need any provider SDK.
 */

interface FetchShotsManifestEvent {
  shotsManifestUrl: string;
}

interface FetchShotsManifestResult {
  shots: unknown[];
}

export const handler = async (event: FetchShotsManifestEvent): Promise<FetchShotsManifestResult> => {
  const res = await fetch(event.shotsManifestUrl);
  if (!res.ok) {
    throw new Error(`fetch-shots-manifest: GET ${event.shotsManifestUrl} -> HTTP ${res.status}`);
  }
  const shots = await res.json();
  if (!Array.isArray(shots)) {
    throw new Error(`fetch-shots-manifest: ${event.shotsManifestUrl} did not resolve to a JSON array`);
  }
  return { shots };
};
