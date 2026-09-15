/**
 * Guardrail store (prompt harness plan §5.0/§9.1). Seed guardrails are
 * git-tracked JSON — already vetted, with real evidence from the Maya
 * cohort. Promoted/learned guardrails live in Postgres
 * (`harness_guardrails`, migration 009) and are merged on top: a DB row
 * with the same id as a seed row wins if its version is higher; a DB row
 * with a new id is added. Retired ids (seed or DB) are dropped.
 *
 * `video-replicate-wan22.json` doesn't exist as a separate file: per the
 * implementation plan §5.2, the Replicate fallback profile inherits every
 * wan2-lightning video rule verbatim — the only difference is the
 * capability TABLE each detector consults (profiles/*.ts), not the rule
 * set itself. This module clones the wan2-lightning seed under the
 * `replicate-wan22-fast` profile name rather than duplicating 19 rows.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Domain, Guardrail } from './types';
import { IMAGE_GUARDRAILS } from './seed/image';
import { VIDEO_WAN2_LIGHTNING_GUARDRAILS } from './seed/video-wan2-lightning';

type Queryable = Pick<Pool | PoolClient, 'query'>;

const IMAGE_SEED = IMAGE_GUARDRAILS;
const VIDEO_WAN2_SEED = VIDEO_WAN2_LIGHTNING_GUARDRAILS;

function cloneForProfile(rows: Guardrail[], profile: string): Guardrail[] {
  return rows.map((r) => ({ ...r, profile }));
}

/** Seed set only — no DB, no I/O. What `harness:lint` and unit tests use. */
export function seedGuardrails(domain: Domain, profile: string): Guardrail[] {
  if (domain === 'image') return IMAGE_SEED;
  if (profile === 'replicate-wan22-fast') return cloneForProfile(VIDEO_WAN2_SEED, 'replicate-wan22-fast');
  return VIDEO_WAN2_SEED;
}

interface DbGuardrailRow {
  id: string;
  version: number;
  domain: string;
  profile: string;
  status: string;
  severity: string;
  title: string;
  detector: unknown;
  fix_target: string;
  corrective: unknown;
  instruction: string;
  evidence: unknown;
}

function fromDbRow(row: DbGuardrailRow): Guardrail {
  return {
    id: row.id,
    domain: row.domain as Domain,
    profile: row.profile,
    version: row.version,
    status: row.status as Guardrail['status'],
    severity: row.severity as Guardrail['severity'],
    title: row.title,
    detector: row.detector as Guardrail['detector'],
    fixTarget: row.fix_target as Guardrail['fixTarget'],
    corrective: row.corrective as Guardrail['corrective'],
    instruction: row.instruction,
    evidence: (row.evidence as string[]) ?? [],
  };
}

/**
 * The active set for lint/compile/the regenerate tool: seed rows (status
 * 'active'/'probation' as authored), overridden/extended by promoted DB
 * rows for the same domain+profile. `db` is optional so pure lint/compile
 * tests never need Postgres — omitting it just skips the promotion layer.
 */
export async function loadActiveGuardrails(db: Queryable | undefined, domain: Domain, profile: string): Promise<Guardrail[]> {
  const seed = seedGuardrails(domain, profile).filter((g) => g.status === 'active' || g.status === 'probation');
  if (!db) return seed;

  const { rows } = await db.query<DbGuardrailRow>(
    `SELECT DISTINCT ON (id) id, version, domain, profile, status, severity, title, detector, fix_target, corrective, instruction, evidence
       FROM harness_guardrails
      WHERE domain = $1 AND (profile = $2 OR profile = 'any') AND status IN ('active', 'probation')
      ORDER BY id, version DESC`,
    [domain, profile],
  );
  const learned = rows.map(fromDbRow);

  const byId = new Map<string, Guardrail>();
  for (const g of seed) byId.set(g.id, g);
  for (const g of learned) {
    const existing = byId.get(g.id);
    if (!existing || g.version >= existing.version) byId.set(g.id, g);
  }
  return [...byId.values()];
}

/** Stable hash stamped onto every job/finding — lets us attribute an
 * outcome to the exact rule set that produced it (plan §9.2). */
export function guardrailSetVersion(guardrails: Guardrail[]): string {
  const sorted = [...guardrails].map((g) => `${g.id}@${g.version}`).sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 12);
}
