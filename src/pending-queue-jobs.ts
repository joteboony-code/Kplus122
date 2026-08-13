import type { QueueJob } from "./types";

export type PendingQueueTarget =
  | "images"
  | "ocr-fallback"
  | "line-webhooks";

export interface PendingQueueItem {
  key: string;
  target: PendingQueueTarget;
  body: QueueJob;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

const PENDING_QUEUE_PREFIX = "pending-queue:v1:";
const PENDING_QUEUE_TTL_SECONDS = 2 * 24 * 60 * 60;
const MAX_ERROR_LENGTH = 500;

function bangkokDateKey(value: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function queueJobTimestampMs(body: QueueJob): number | undefined {
  if ("kind" in body) {
    if (body.kind === "line-webhook") return body.receivedAtMs;
    if (body.kind === "paddle-poll" || body.kind === "ocr-fallback") {
      return body.job.timestamp;
    }
    // A round finalizer has no image timestamp. Its Durable Object generation
    // check still protects it from duplicate/stale finalization.
    return undefined;
  }
  return body.timestamp;
}

/** Jobs are valid only during the Bangkok calendar day in which LINE received them. */
export function isCurrentQueueJobDay(
  body: QueueJob,
  now = Date.now(),
): boolean {
  const timestamp = queueJobTimestampMs(body);
  if (!Number.isFinite(timestamp) || timestamp === undefined) return true;
  return bangkokDateKey(timestamp) === bangkokDateKey(now);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

function jobIdentity(body: QueueJob): string {
  if ("messageId" in body && "webhookEventId" in body) {
    return `image:${body.webhookEventId}:${body.messageId}`;
  }
  if ("kind" in body && body.kind === "round-finalize") {
    return `round:${body.roundKey}:${body.generation}`;
  }
  if ("kind" in body && body.kind === "failure-finalize") {
    return `failure:${body.roundKey}:${body.generation}`;
  }
  if ("kind" in body && body.kind === "paddle-poll") {
    return `paddle:${body.job.webhookEventId}:${body.job.messageId}:${body.paddleJobId}:${body.pollCount}`;
  }
  if ("kind" in body && body.kind === "ocr-fallback") {
    return `fallback:${body.job.webhookEventId}:${body.job.messageId}`;
  }
  if ("kind" in body && body.kind === "line-webhook") {
    const firstEvent = body.events[0];
    return `line:${body.receivedAtMs}:${firstEvent?.webhookEventId ?? "empty"}`;
  }
  return "unknown";
}

export function pendingQueueKey(
  target: PendingQueueTarget,
  body: QueueJob,
): string {
  return `${PENDING_QUEUE_PREFIX}${target}:${encodeURIComponent(jobIdentity(body))}`;
}

export function pendingQueueItem(
  target: PendingQueueTarget,
  body: QueueJob,
  error?: unknown,
  now = Date.now(),
): PendingQueueItem {
  return {
    key: pendingQueueKey(target, body),
    target,
    body,
    attempts: 0,
    nextAttemptAt: now,
    lastError: error === undefined ? undefined : errorText(error),
  };
}

function encodeItem(item: PendingQueueItem): string {
  return JSON.stringify(item);
}

function decodeItem(key: string, value: string): PendingQueueItem | null {
  try {
    const parsed = JSON.parse(value) as Partial<PendingQueueItem>;
    if (
      typeof parsed.target !== "string" ||
      !["images", "ocr-fallback", "line-webhooks"].includes(parsed.target) ||
      typeof parsed.body !== "object" ||
      parsed.body === null ||
      typeof parsed.attempts !== "number" ||
      typeof parsed.nextAttemptAt !== "number"
    ) {
      return null;
    }
    return {
      key,
      target: parsed.target as PendingQueueTarget,
      body: parsed.body as QueueJob,
      attempts: parsed.attempts,
      nextAttemptAt: parsed.nextAttemptAt,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
    };
  } catch {
    return null;
  }
}

function upsertStatement(
  db: D1Database,
  item: PendingQueueItem,
  now = Date.now(),
): D1PreparedStatement {
  const expiresAt = Math.floor(now / 1000) + PENDING_QUEUE_TTL_SECONDS;
  return db.prepare(`INSERT INTO control_state (key, value, updated_at, expires_at)
      VALUES (?, ?, unixepoch(), ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at`)
    .bind(item.key, encodeItem(item), expiresAt);
}

export async function savePendingQueueJobs(
  db: D1Database,
  target: PendingQueueTarget,
  bodies: QueueJob[],
  error?: unknown,
  now = Date.now(),
): Promise<number> {
  const unique = new Map<string, PendingQueueItem>();
  for (const body of bodies) {
    const item = pendingQueueItem(target, body, error, now);
    unique.set(item.key, item);
  }
  if (unique.size === 0) return 0;
  await db.batch([...unique.values()].map((item) => upsertStatement(db, item, now)));
  return unique.size;
}

export async function listPendingQueueJobs(
  db: D1Database,
  now = Date.now(),
  limit = 100,
): Promise<PendingQueueItem[]> {
  const result = await db.prepare(`SELECT key, value
      FROM control_state
      WHERE key LIKE ?
        AND (expires_at IS NULL OR expires_at > unixepoch())
      ORDER BY updated_at ASC
      LIMIT ?`)
    .bind(`${PENDING_QUEUE_PREFIX}%`, Math.min(Math.max(limit, 1), 100))
    .all<{ key: string; value: string }>();
  const items = result.results
    .map((row) => decodeItem(row.key, row.value))
    .filter((item): item is PendingQueueItem => item !== null);
  const expired = items.filter((item) => !isCurrentQueueJobDay(item.body, now));
  if (expired.length > 0) {
    await db.batch(expired.map((item) => db.prepare("DELETE FROM control_state WHERE key = ?").bind(item.key)));
  }
  return items.filter((item) =>
    isCurrentQueueJobDay(item.body, now) && item.nextAttemptAt <= now,
  );
}

export async function removePendingQueueJob(
  db: D1Database,
  key: string,
): Promise<void> {
  await db.prepare("DELETE FROM control_state WHERE key = ?").bind(key).run();
}

export async function deferPendingQueueJob(
  db: D1Database,
  item: PendingQueueItem,
  error: unknown,
  now = Date.now(),
): Promise<void> {
  const attempts = item.attempts + 1;
  const delaySeconds = Math.min(60 * 2 ** Math.min(attempts, 5), 60 * 60);
  await db.batch([
    upsertStatement(db, {
      ...item,
      attempts,
      nextAttemptAt: now + delaySeconds * 1000,
      lastError: errorText(error),
    }, now),
  ]);
}
