import { describe, expect, it } from "vitest";
import {
  RECEIPT_ROUND_SECONDS,
  recordReceiptEvidence,
} from "../src/receipt-round";
import type { ImageJob } from "../src/types";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  } as KVNamespace;
}

function job(messageId: string, sender = "U1", group = "G1"): ImageJob {
  return {
    webhookEventId: `event-${messageId}`,
    messageId,
    replyToken: `reply-${messageId}`,
    replyTarget: group,
    sourceType: "group",
    senderUserId: sender,
  };
}

describe("receipt round state", () => {
  it("completes only after separate KPLUS and KBANK images from one sender", async () => {
    const kv = memoryKv();
    const first = await recordReceiptEvidence(kv, job("kplus"), "kplus", 1.22, 1_000);
    const second = await recordReceiptEvidence(kv, job("kbank"), "kbank", 54.88, 2_000);

    expect(first).toMatchObject({ complete: false, hasKplus: true, hasKbank: false });
    expect(second).toMatchObject({
      complete: true,
      hasKplus: true,
      hasKbank: true,
      kplusAmount: 1.22,
      kbankAmount: 54.88,
    });
  });

  it("does not combine evidence from different senders", async () => {
    const kv = memoryKv();
    await recordReceiptEvidence(kv, job("kplus", "U1"), "kplus", 1.22, 1_000);
    const result = await recordReceiptEvidence(kv, job("kbank", "U2"), "kbank", 20, 2_000);

    expect(result.complete).toBe(false);
    expect(result.hasKplus).toBe(false);
    expect(result.hasKbank).toBe(true);
  });

  it("does not count one image as both receipt types", async () => {
    const kv = memoryKv();
    await recordReceiptEvidence(kv, job("same"), "kplus", 1.22, 1_000);
    const result = await recordReceiptEvidence(kv, job("same"), "kbank", 50, 2_000);

    expect(result.complete).toBe(false);
  });

  it("starts a new round after five minutes", async () => {
    const kv = memoryKv();
    await recordReceiptEvidence(kv, job("kplus"), "kplus", 1.22, 1_000);
    const result = await recordReceiptEvidence(
      kv,
      job("kbank"),
      "kbank",
      50,
      1_000 + RECEIPT_ROUND_SECONDS * 1_000 + 1,
    );

    expect(result).toMatchObject({ complete: false, hasKplus: false, hasKbank: true });
  });
});
