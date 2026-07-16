import type { StateStore } from "./state-store";
import type { ImageJob, RoundFinalizeJob } from "./types";

export const ROUND_INACTIVITY_SECONDS = 20;
export const ROUND_STATE_TTL_SECONDS = 10 * 60;
export const ROUND_COMPLETED_SUPPRESSION_SECONDS = 60;
export const ROUND_FINALIZATION_LEASE_SECONDS = 45;
export const ROUND_PASS_CLAIM_LEASE_SECONDS = 2 * 60;

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
  passOwnerMessageId?: string;
  passClaimedAt?: number;
  finalizationClaimedAt?: number;
}

export interface RoundFinalization {
  status: "stale" | "waiting" | "busy" | "finalized";
  retryAfterSeconds?: number;
  evidence?: RoundEvidence;
}

export type RoundPassClaim = "acquired" | "busy" | "suppressed";

function passClaimIsActive(current: ReceiptRoundState, now: number): boolean {
  return current.passOwnerMessageId !== undefined &&
    current.passClaimedAt !== undefined &&
    now - current.passClaimedAt < ROUND_PASS_CLAIM_LEASE_SECONDS * 1000;
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
  if (current && passClaimIsActive(current, now)) return null;
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

export async function claimRoundPass(
  job: ImageJob,
  state: StateStore,
  now = Date.now(),
): Promise<RoundPassClaim> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return "acquired";

  const current = parseRoundState(await state.get(roundKey));
  if (
    current?.completedAt !== undefined &&
    now - current.completedAt < ROUND_COMPLETED_SUPPRESSION_SECONDS * 1000
  ) {
    return "suppressed";
  }
  if (current && passClaimIsActive(current, now)) {
    return current.passOwnerMessageId === job.messageId
      ? "busy"
      : "suppressed";
  }

  const processedMessageIds = current?.processedMessageIds.includes(job.messageId)
    ? current.processedMessageIds
    : [...(current?.processedMessageIds ?? []), job.messageId];
  await state.put(roundKey, JSON.stringify({
    generation: crypto.randomUUID(),
    updatedAt: now,
    processedMessageIds,
    passOwnerMessageId: job.messageId,
    passClaimedAt: now,
  } satisfies ReceiptRoundState), { expirationTtl: ROUND_STATE_TTL_SECONDS });
  return "acquired";
}

export async function releaseRoundPass(
  job: ImageJob,
  state: StateStore,
): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  const current = parseRoundState(await state.get(roundKey));
  if (!current || current.passOwnerMessageId !== job.messageId) return;
  const {
    passOwnerMessageId: _owner,
    passClaimedAt: _claimedAt,
    ...next
  } = current;
  await state.put(roundKey, JSON.stringify(next), {
    expirationTtl: ROUND_STATE_TTL_SECONDS,
  });
}

export async function completeRoundAfterPass(
  job: ImageJob,
  state: StateStore,
  now = Date.now(),
): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  const current = parseRoundState(await state.get(roundKey));
  if (
    current?.passOwnerMessageId !== undefined &&
    current.passOwnerMessageId !== job.messageId
  ) {
    return;
  }
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

  if (
    current.finalizationClaimedAt !== undefined &&
    now - current.finalizationClaimedAt < ROUND_FINALIZATION_LEASE_SECONDS * 1000
  ) {
    return {
      status: "busy",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (ROUND_FINALIZATION_LEASE_SECONDS * 1000 -
            (now - current.finalizationClaimedAt)) / 1000,
        ),
      ),
    };
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
    finalizationClaimedAt: now,
  }), { expirationTtl: ROUND_STATE_TTL_SECONDS });
  return { status: "finalized", evidence: current.evidence };
}

export async function releaseRoundFinalization(
  job: RoundFinalizeJob,
  state: StateStore,
): Promise<void> {
  const current = parseRoundState(await state.get(job.roundKey));
  if (!current || current.generation !== job.generation) return;
  const { finalizationClaimedAt: _claim, ...next } = current;
  await state.put(job.roundKey, JSON.stringify(next), {
    expirationTtl: ROUND_STATE_TTL_SECONDS,
  });
}

export async function completeRoundFinalization(
  job: RoundFinalizeJob,
  state: StateStore,
): Promise<void> {
  const current = parseRoundState(await state.get(job.roundKey));
  if (!current || current.generation !== job.generation) return;
  await state.delete(job.roundKey);
}
