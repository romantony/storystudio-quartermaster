/**
 * Digs an asset URL out of RunPod's variable output shape. Originally ported
 * verbatim from src/adapters/runpod.ts's `runpodOutUrl` — same recursive-dig
 * behavior, needed by both the generator's synchronous-completion path and
 * the webhook receiver (impl plan §7.2/§6.4) — but the key ORDER has since
 * diverged from that source on purpose (real incident, 2026-09-12): step 11
 * (burn captions)'s real output carries BOTH `srt` and `video`
 * (`{srt, transcript, video, word_count}` — containers/media.md's `caption`
 * mode), the first step whose output has two URL-shaped fields at once. The
 * original key list put `srt`/`srt_url` ahead of `video`/`video_url`, so a
 * consumer of step 11's output (step 12/bgm-overlay) silently resolved the
 * SUBTITLE file instead of the captioned video — ffmpeg's own error caught
 * it ("Stream map '0:v:0' matches no streams", since the "video" it was
 * given was actually an SRT file), but only at generation time, not at
 * plan/resolve time. `video`/`video_url`/`videoUrl` now sort before
 * `srt`/`srt_url`: every current and foreseeable caller in this orchestrator
 * that consumes a step producing both wants the video, never the SRT alone,
 * as a "resolved dependency URL" to feed into a later step.
 */
export function runpodOutUrl(p: unknown): string | undefined {
  const dig = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('http')) return x;
    if (Array.isArray(x)) return x.map(dig).find(Boolean);
    if (x && typeof x === 'object') {
      const keys = [
        'image', 'image_url', 'imageUrl', 'audio', 'audio_url',
        'video_url', 'videoUrl', 'video', 'srt', 'srt_url',
        'output_url', 'url', 'output', 'result', 'artifacts',
      ];
      return keys.map((k) => dig((x as Record<string, unknown>)[k])).find(Boolean);
    }
    return undefined;
  };
  return dig(p);
}
