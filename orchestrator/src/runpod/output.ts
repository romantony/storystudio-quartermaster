/**
 * Digs an asset URL out of RunPod's variable output shape. Ported verbatim
 * from src/adapters/runpod.ts's `runpodOutUrl` — same key list, same
 * recursive-dig behavior, needed by both the generator's synchronous-
 * completion path and the webhook receiver (impl plan §7.2/§6.4).
 */
export function runpodOutUrl(p: unknown): string | undefined {
  const dig = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('http')) return x;
    if (Array.isArray(x)) return x.map(dig).find(Boolean);
    if (x && typeof x === 'object') {
      const keys = [
        'image', 'image_url', 'imageUrl', 'audio', 'audio_url', 'srt', 'srt_url',
        'video_url', 'videoUrl', 'output_url', 'url', 'output', 'result', 'video', 'artifacts',
      ];
      return keys.map((k) => dig((x as Record<string, unknown>)[k])).find(Boolean);
    }
    return undefined;
  };
  return dig(p);
}
