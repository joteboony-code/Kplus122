import type { StateStore } from "./state-store";
import type { ImageJob, RoundFinalizeJob } from "./types";

export const ROUND_INACTIVITY_SECONDS = 20;
export const ROUND_STATE_TTL_SECONDS = 10 * 60;
export const ROUND_COMPLETED_SUPPRESSION_SECONDS = 60;

export type RoundEvidenceKind = "wrong-amount" | "uncertain";

export interface RoundEvidence {
  kind: RoundEvidenceKind;
  text: string;
  job: ImageJob;
}

interface ReceiptRoundState {
  generation: string;
  updatedAt: number;
  processedMessageIds: string[];
  evidence?: RoundEvidence;
  completedAt?: number;
}

export interface RoundFinalization {
  status: "stale" | "waiting" | "finalized";
  retryAfterSeconds?: number;
  evidence?: RoundEvidence;
}

export function receiptRoundKey(job: ImageJob): string | null {
  const conversationId = job.replyTarget;
  const senderId = job.senderUserId ?? job.replyTarget;
  if (!conversationId || !senderId) return null;
  return `receipt-round:v2:${conversationId}:${senderId}:${job.referenceCode ?? "no-reference"}`;
}

function betterEvidence(
  current: RoundEvidence | undefined,
  incoming: RoundEvidence | undefined,
): RoundEvidence | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.kind === "wrong-amount" && current.kind !== "wrong-amount") {
    return incoming;
  }
  return current.kind === incoming.kind ? incoming : current;
}

function parseRoundState(value: string | null): ReceiptRoundState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReceiptRoundState>;
    if (
      typeof parsed.generation !== "string" ||
      typeof parsed.updatedAt !== "number" ||
      !Array.isArray(parsed.processedMessageIds)
    ) {
      return null;
    }
    return parsed as ReceiptRoundState;
  } catch {
    return null;
  }
}

export async function recordRoundActivity(
  job: ImageJob,
  evidence: RoundEvidence | undefined,
  state: StateStore,
  now = Date.now(),
  generation = crypto.randomUUID(),
): Promise<RoundFinalizeJob | null> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return null;

  const current = parseRoundState(await state.get(roundKey));
  if (
    current?.completedAt !== undefined &&
    now - current.completedAt < ROUND_COMPLETED_SUPPRESSION_SECONDS * 1000
  ) {
    return null;
  }
  const active = current && current.completedAt === undefined ? current : null;
  const processedMessageIds = active?.processedMessageIds.includes(job.messageId)
    ? active.processedMessageIds
    : [...(active?.processedMessageIds ?? []), job.messageId];
  const next: ReceiptRoundState = {
    generation,
    updatedAt: now,
    processedMessageIds,
    evidence: betterEvidence(active?.evidence, evidence),
  };
  await state.put(roundKey, JSON.stringify(next), {
    expirationTtl: ROUND_STATE_TTL_SECONDS,
  });
  return { kind: "round-finalize", roundKey, generation };
}

export async function completeRoundAfterPass(
  job: ImageJob,
  state: StateStore,
  now = Date.now(),
): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  const current = parseRoundState(await state.get(roundKey));
  const next: ReceiptRoundState = {
    generation: crypto.randomUUID(),
    updatedAt: now,
    processedMessageIds: current?.processedMessageIds.includes(job.messageId)
      ? current.processedMessageIds
      : [...(current?.processedMessageIds ?? []), job.messageId],
    completedAt: now,
  };
  await state.put(roundKey, JSON.stringify(next), {
    expirationTtl: ROUND_STATE_TTL_SECONDS,
  });
}

export async function finalizeRound(
  job: RoundFinalizeJob,
  state: StateStore,
  now = Date.now(),
): Promise<RoundFinalization> {
  const current = parseRoundState(await state.get(job.roundKey));
  if (
    !current ||
    current.completedAt !== undefined ||
    current.generation !== job.generation
  ) {
    return { status: "stale" };
  }

  const elapsedMs = now - current.updatedAt;
  const inactivityMs = ROUND_INACTIVITY_SECONDS * 1000;
  if (elapsedMs < inactivityMs) {
    return {
      status: "waiting",
      retryAfterSeconds: Math.max(1, Math.ceil((inactivityMs - elapsedMs) / 1000)),
    };
  }

  await state.put(job.roundKey, JSON.stringify({
    ...current,
    completedAt: now,
  }), { expirationTtl: ROUND_STATE_TTL_SECONDS });
  return { status: "finalized", evidence: current.evidence };
}
