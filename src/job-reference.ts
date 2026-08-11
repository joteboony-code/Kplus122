import type { StateStore } from "./state-store";

const REFERENCE_TTL_SECONDS = 30 * 60;

interface JobReferenceEntry {
  referenceCode: string;
  timestamp: number;
}

interface JobReferenceState {
  entries: JobReferenceEntry[];
}

const MAX_REFERENCE_HISTORY = 16;

function validTimestamp(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function parseReferenceState(value: string | null): JobReferenceEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Partial<JobReferenceState>;
    if (Array.isArray(parsed.entries)) {
      return parsed.entries
        .filter((entry): entry is JobReferenceEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.referenceCode === "string" &&
          /^\d{8}$/.test(entry.referenceCode) &&
          typeof entry.timestamp === "number" &&
          Number.isFinite(entry.timestamp),
        )
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-MAX_REFERENCE_HISTORY);
    }
  } catch {
    // Older deployments stored the latest TID as plain text. Keep reading it.
  }
  return /^\d{8}$/.test(value)
    ? [{ referenceCode: value, timestamp: Number.NEGATIVE_INFINITY }]
    : [];
}

export function jobReferenceKey(conversationId: string, senderId: string): string {
  return `job-reference:v1:${conversationId}:${senderId}`;
}

export async function storeJobReference(
  conversationId: string,
  senderId: string,
  referenceCode: string,
  state: StateStore,
  timestamp?: number,
): Promise<void> {
  if (!/^\d{8}$/.test(referenceCode)) {
    throw new Error("Job reference must contain exactly 8 digits");
  }
  const key = jobReferenceKey(conversationId, senderId);
  const current = parseReferenceState(await state.get(key));
  const entry: JobReferenceEntry = {
    referenceCode,
    timestamp: validTimestamp(timestamp) ?? Date.now(),
  };
  const entries = [
    ...current.filter((item) => item.timestamp !== entry.timestamp),
    entry,
  ]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_REFERENCE_HISTORY);
  await state.put(key, JSON.stringify({ entries } satisfies JobReferenceState), {
    expirationTtl: REFERENCE_TTL_SECONDS,
  });
}

export async function getJobReference(
  conversationId: string,
  senderId: string,
  state: StateStore,
  atTimestamp?: number,
): Promise<string | undefined> {
  const entries = parseReferenceState(
    await state.get(jobReferenceKey(conversationId, senderId)),
  );
  if (entries.length === 0) return undefined;
  const timestamp = validTimestamp(atTimestamp);
  if (timestamp === null) return entries.at(-1)?.referenceCode;
  return entries
    .filter((entry) => entry.timestamp <= timestamp)
    .at(-1)?.referenceCode;
}
