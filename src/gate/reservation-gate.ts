import {
  AttributeValue, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { ReservationItem } from '../types';

/**
 * Reservation persistence — the shared low-level store behind the admission gate
 * (src/handlers/admission.ts) AND the capacity manager (src/handlers/provisioner.ts).
 * Split out (mirrors dynamo-gate.ts) so provisioner.ts can read reservation-committed
 * worker demand (§WS-C2) without an admission.ts <-> provisioner.ts import cycle —
 * admission.ts already imports from provisioner.ts for live fleet state.
 */

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const db = new DynamoDBClient({});

export async function saveReservation(reservation: ReservationItem): Promise<void> {
  await db.send(new PutItemCommand({
    TableName: TABLE, Item: marshall(reservation, { removeUndefinedValues: true }),
  }));
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(
      {
        pk: `RESERVATIONREQ#${reservation.requestId}`, sk: 'META',
        admissionId: reservation.admissionId, ttl: reservation.ttl,
      },
      { removeUndefinedValues: true },
    ),
  }));
}

export async function getReservationByRequestId(requestId: string): Promise<ReservationItem | null> {
  const ptr = await db.send(new GetItemCommand({
    TableName: TABLE, Key: marshall({ pk: `RESERVATIONREQ#${requestId}`, sk: 'META' }),
  }));
  if (!ptr.Item) return null;
  const { admissionId } = unmarshall(ptr.Item) as { admissionId: string };
  return getReservationByAdmissionId(admissionId);
}

export async function getReservationByAdmissionId(admissionId: string): Promise<ReservationItem | null> {
  const r = await db.send(new GetItemCommand({
    TableName: TABLE, Key: marshall({ pk: `RESERVATION#${admissionId}`, sk: 'META' }),
  }));
  return r.Item ? (unmarshall(r.Item) as ReservationItem) : null;
}

/** Idempotent: marks active→released; already-released/expired is a no-op success. */
export async function releaseReservation(
  admissionId: string, outcome?: string,
): Promise<{ released: boolean; notFound?: boolean }> {
  const reservation = await getReservationByAdmissionId(admissionId);
  if (!reservation) return { released: false, notFound: true };

  if (reservation.status === 'active') {
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: reservation.pk, sk: 'META' }),
      UpdateExpression: 'SET #s = :released, releasedAt = :now, outcome = :o',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':released': 'released', ':now': Date.now(), ':o': outcome ?? 'unknown' }),
    }));
  }
  return { released: true };
}

/** Expire active reservations past their TTL. Called from the 2-min sweeper. */
export async function expireStaleReservations(): Promise<{ expired: number }> {
  const now = Date.now();
  const active = await listActiveReservations();
  let expired = 0;
  for (const r of active) {
    if (r.expiresAt >= now) continue;
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: r.pk, sk: 'META' }),
      UpdateExpression: 'SET #s = :expired',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':expired': 'expired' }),
    }));
    expired++;
  }
  return { expired };
}

/**
 * Active reservations are few (concurrent MCP projects, not per-asset jobs). Queries
 * the sparse reservation-status-index (sk:'META' + status — only ReservationItem
 * records ever set both; the RESERVATIONREQ# pointer items share sk:'META' but never
 * have `status`, so they're naturally excluded) instead of scanning the whole table.
 * The prior full-table Scan was billed for every item in the table, not just active
 * reservations, and this is called every 2 minutes by the sweeper plus on every
 * admission check.
 */
export async function listActiveReservations(): Promise<ReservationItem[]> {
  const items: ReservationItem[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await db.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'reservation-status-index',
      KeyConditionExpression: 'sk = :sk AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':sk': 'META', ':active': 'active' }),
      ExclusiveStartKey: lastKey,
    }));
    for (const raw of result.Items ?? []) items.push(unmarshall(raw) as ReservationItem);
    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);
  return items;
}

/**
 * Sum of workers committed by active reservations, per RunPod endpoint — the
 * capacity manager's reservation-aware demand signal (§WS-C2). A pool a project
 * has been granted for should hold warm (or pre-warm) even before any of its
 * jobs are actually queued/inflight, so it isn't scaled down out from under it.
 */
export async function getReservedWorkersByEndpoint(): Promise<Record<string, number>> {
  const active = await listActiveReservations();
  const out: Record<string, number> = {};
  for (const r of active) {
    for (const [ck, workers] of Object.entries(r.neededWorkers)) {
      out[ck] = (out[ck] ?? 0) + workers;
    }
  }
  return out;
}
