/**
 * X-Docgen-Signature: `sha256=<hex HMAC-SHA256 of the RAW body, keyed with DOCGEN_CALLBACK_SECRET>`.
 * Must be computed over the bytes as received, never re-serialized JSON.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signDocgenBody(secret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function verifyDocgenSignature(raw: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signDocgenBody(secret, raw));
  const got = Buffer.from(header);
  // Length check first: timingSafeEqual throws on unequal lengths.
  return got.length === expected.length && timingSafeEqual(got, expected);
}
