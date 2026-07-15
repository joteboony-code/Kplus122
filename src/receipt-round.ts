import type { ImageJob } from "./types";

export const RECEIPT_ROUND_SECONDS = 5 * 60;

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
  return `receipt-round:v1:${conversation}:${sender}`;
}

function parseState(value: string | null, now: number): ReceiptRoundState {
  if (!value) return { updatedAt: now };
  try {
    const state = JSON.parse(value) as ReceiptRoundState;
    if (
      typeof state.updatedAt !== "number" ||
      now - state.updatedAt > RECEIPT_ROUND_SECONDS * 1000
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
  const state = parseState(await kv.get(key), now);
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
      expirationTtl: RECEIPT_ROUND_SECONDS,
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
