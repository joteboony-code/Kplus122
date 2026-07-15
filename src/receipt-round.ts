import type { ImageJob } from "./types";

export const RECEIPT_ROUND_SECONDS = 5 * 60;
export const IMAGE_SET_RETENTION_SECONDS = 60 * 60;

export type ReceiptKind = "kplus" | "kbank";

interface RoundEvidence {
  messageId: string;
  amount: number;
  detectedAt: number;
}

interface ReceiptRoundState {
  updatedAt: number;
  kplus?: RoundEvidence;
  kbank?: RoundEvidence;
}

export interface ReceiptRoundResult {
  complete: boolean;
  hasKplus: boolean;
  hasKbank: boolean;
  kplusAmount?: number;
  kbankAmount?: number;
}

function roundKey(job: ImageJob): string {
  const conversation = job.replyTarget ?? `${job.sourceType ?? "unknown"}:unknown`;
  const sender = job.senderUserId ?? job.replyTarget ?? "unknown";
  if (job.imageSetId) {
    return `receipt-round:v2:image-set:${conversation}:${sender}:${job.imageSetId}`;
  }
  return `receipt-round:v2:fallback:${conversation}:${sender}`;
}

function retentionSeconds(job: ImageJob): number {
  return job.imageSetId ? IMAGE_SET_RETENTION_SECONDS : RECEIPT_ROUND_SECONDS;
}

function parseState(
  value: string | null,
  now: number,
  retention: number,
): ReceiptRoundState {
  if (!value) return { updatedAt: now };
  try {
    const state = JSON.parse(value) as ReceiptRoundState;
    if (
      typeof state.updatedAt !== "number" ||
      now - state.updatedAt > retention * 1000
    ) {
      return { updatedAt: now };
    }
    return state;
  } catch {
    return { updatedAt: now };
  }
}

export async function recordReceiptEvidence(
  kv: KVNamespace,
  job: ImageJob,
  kind: ReceiptKind,
  amount: number,
  now = Date.now(),
): Promise<ReceiptRoundResult> {
  const key = roundKey(job);
  const retention = retentionSeconds(job);
  const state = parseState(await kv.get(key), now, retention);
  state.updatedAt = now;
  state[kind] = { messageId: job.messageId, amount, detectedAt: now };

  const complete = Boolean(
    state.kplus &&
    state.kbank &&
    state.kplus.messageId !== state.kbank.messageId,
  );

  if (complete) {
    await kv.delete(key);
  } else {
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: retention,
    });
  }

  return {
    complete,
    hasKplus: Boolean(state.kplus),
    hasKbank: Boolean(state.kbank),
    kplusAmount: state.kplus?.amount,
    kbankAmount: state.kbank?.amount,
  };
}
