/**
 * doc-gen intake validation and the mapping to the instance payload
 * (src/docgen/request.ts).
 */
import { validateIntake, buildDocgenPayload, docgenRequestIdFor, DocgenValidationError, MAX_REQUEST_ID_LEN } from '../src/docgen/request';

const base = {
  requestId: 'req_k57c9x2m_20261012T0900',
  projectId: 'k57c9x2m8f3q0r1t6y4w',
  source: 'mcp',
  tier: 'documentary-basic',
  callbackUrl: 'https://x.convex.site/api/qm/result',
  topic: 'The Treaty of Versailles',
  synopsis: 'How the 1919 peace settlement was negotiated.',
};
const ctx = { reviewMode: 'auto' as const, model: 'claude-sonnet-5-5', publicBaseUrl: 'https://orchestrator.ai-storystudio.com/' };

describe('validateIntake', () => {
  it('accepts the minimal body', () => {
    expect(validateIntake(base).topic).toBe('The Treaty of Versailles');
  });

  it('rejects unknown fields — a typo must not fall back to a paid default', () => {
    expect(() => validateIntake({ ...base, talkingClips: 5 })).toThrow(DocgenValidationError);
    expect(() => validateIntake({ ...base, visuals: { talkingClip: 5 } })).toThrow(DocgenValidationError);
  });

  it('rejects fields the orchestrator owns', () => {
    for (const k of ['review_mode', 'reviewMode', 'model', 'limits', 'output', 'callback']) {
      expect(() => validateIntake({ ...base, [k]: 'x' })).toThrow(DocgenValidationError);
    }
  });

  it('enforces doc-gen limits, with the offending path in the issue', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ targetSeconds: 59 }, 'targetSeconds'],
      [{ targetSeconds: 1801 }, 'targetSeconds'],
      [{ topic: 'x'.repeat(201) }, 'topic'],
      [{ synopsis: 'x'.repeat(1001) }, 'synopsis'],
      [{ shorts: { count: 4 } }, 'shorts'],
      [{ visuals: { talkingClips: 6 } }, 'visuals'],
      [{ visuals: { animatedStills: 16 } }, 'visuals'],
      [{ shorts: { angles: ['bogus'] } }, 'shorts'],
    ];
    for (const [patch, path] of cases) {
      try {
        validateIntake({ ...base, ...patch });
        throw new Error(`expected rejection for ${JSON.stringify(patch)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(DocgenValidationError);
        expect((e as DocgenValidationError).issues[0].path[0]).toBe(path);
      }
    }
  });

  it('requires an https callbackUrl, a legal requestId, and source mcp', () => {
    expect(() => validateIntake({ ...base, callbackUrl: 'http://x.example/cb' })).toThrow(DocgenValidationError);
    expect(() => validateIntake({ ...base, requestId: 'has space' })).toThrow(DocgenValidationError);
    expect(() => validateIntake({ ...base, requestId: 'a'.repeat(MAX_REQUEST_ID_LEN + 1) })).toThrow(DocgenValidationError);
    expect(validateIntake({ ...base, requestId: 'a'.repeat(MAX_REQUEST_ID_LEN) }).requestId).toHaveLength(MAX_REQUEST_ID_LEN);
    expect(() => validateIntake({ ...base, source: 'ui' })).toThrow(DocgenValidationError);
  });

  it('a max-length requestId still fits doc-gen\'s 64 characters after a retry suffix', () => {
    const id = 'a'.repeat(MAX_REQUEST_ID_LEN);
    expect(docgenRequestIdFor(id, 2).length).toBeLessThanOrEqual(64);
    expect(docgenRequestIdFor(id, 5).length).toBeLessThanOrEqual(64);
  });
});

describe('docgenRequestIdFor', () => {
  it('is the requestId on attempt 1 and gets an -rN suffix after (a failed id is never reused)', () => {
    expect(docgenRequestIdFor('req_1', 1)).toBe('req_1');
    expect(docgenRequestIdFor('req_1', 2)).toBe('req_1-r2');
  });
});

describe('buildDocgenPayload', () => {
  it('sends only what was asked for, so the instance defaults apply to the rest', () => {
    const p = buildDocgenPayload(validateIntake(base), 'req_1', ctx);
    expect(p).toEqual({
      request_id: 'req_1',
      topic: 'The Treaty of Versailles',
      synopsis: 'How the 1919 peace settlement was negotiated.',
      review_mode: 'auto',
      model: 'claude-sonnet-5-5',
      output: { prefix: 'docgen/req_1/' },
      callback: { url: 'https://orchestrator.ai-storystudio.com/v1/webhooks/docgen' },
    });
  });

  it('maps camelCase intake to the snake_case contract', () => {
    const p = buildDocgenPayload(
      validateIntake({
        ...base,
        targetSeconds: 480,
        narratorVoice: 'Charon',
        series: { name: 'Wars', episode: 4, previousEpisodeTitle: 'Prev', playlistUrl: 'https://yt/pl' },
        shorts: { count: 3, angles: ['spark', 'myth'] },
        visuals: { talkingClips: 0, animatedStills: 0, imageGen: false, textOverlays: true, allowGraphicArchive: false },
      }),
      'req_1',
      ctx,
    );
    expect(p.long).toEqual({ target_seconds: 480, narrator_voice: 'Charon' });
    expect(p.series).toEqual({ name: 'Wars', episode: 4, previous_episode_title: 'Prev', playlist_url: 'https://yt/pl' });
    expect(p.shorts).toEqual({ count: 3, angles: ['spark', 'myth'] });
    // 0 and false are real choices (they switch paid generation off) and must survive — not be dropped as falsy.
    expect(p.visuals).toEqual({ talking_clips: 0, animated_stills: 0, image_gen: false, text_overlays: true, allow_graphic_archive: false });
  });

  it('prefixes outputs and uses the instance id, not ours, on a retry', () => {
    const p = buildDocgenPayload(validateIntake(base), 'req_1-r2', ctx);
    expect(p.request_id).toBe('req_1-r2');
    expect(p.output.prefix).toBe('docgen/req_1-r2/');
  });

  it('omits an empty series/visuals object rather than sending {}', () => {
    const p = buildDocgenPayload(validateIntake({ ...base, series: {}, visuals: {}, shorts: {} }), 'req_1', ctx);
    expect(p).not.toHaveProperty('series');
    expect(p).not.toHaveProperty('visuals');
    expect(p).not.toHaveProperty('shorts');
  });
});
