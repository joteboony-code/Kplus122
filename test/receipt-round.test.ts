import { describe, expect, it } from "vitest";
import {
  completeRoundAfterPass,
  finalizeRound,
  receiptRoundKey,
  recordRoundActivity,
  ROUND_INACTIVITY_SECONDS,
} from "../src/receipt-round";
import type { StateStore } from "../src/state-store";
import type { ImageJob } from "../src/types";

function memoryState(): StateStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
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
  it("uses a 20-second inactivity window", () => {
    expect(ROUND_INACTIVITY_SECONDS).toBe(20);
  });

  it("groups separate LINE albums from the same sender and conversation", () => {
    expect(receiptRoundKey({ ...job("one"), imageSetId: "album-A" })).toBe(
      receiptRoundKey({ ...job("two"), imageSetId: "album-B" }),
    );
    expect(receiptRoundKey(job("two", "U2"))).not.toBe(receiptRoundKey(job("one")));
  });

  it("resets the inactivity timer when another image is processed", async () => {
    const state = memoryState();
    const first = await recordRoundActivity(
      job("one"),
      { kind: "wrong-amount", text: "wrong", job: job("one") },
      state,
      1_000,
      "generation-1",
    );
    const second = await recordRoundActivity(
      job("two"),
      undefined,
      state,
      11_000,
      "generation-2",
    );

    expect(await finalizeRound(first!, state, 21_000)).toEqual({ status: "stale" });
    expect(await finalizeRound(second!, state, 30_000)).toEqual({
      status: "waiting",
      retryAfterSeconds: 1,
    });
    expect((await finalizeRound(second!, state, 31_000)).status).toBe("finalized");
  });

  it("keeps a wrong amount over a later unclear image", async () => {
    const state = memoryState();
    await recordRoundActivity(
      job("one"),
      { kind: "wrong-amount", text: "wrong amount", job: job("one") },
      state,
      0,
      "generation-1",
    );
    const finalizer = await recordRoundActivity(
      job("two"),
      { kind: "uncertain", text: "unclear", job: job("two") },
      state,
      10_000,
      "generation-2",
    );

    const result = await finalizeRound(
      finalizer!,
      state,
      10_000 + ROUND_INACTIVITY_SECONDS * 1000,
    );
    expect(result).toMatchObject({
      status: "finalized",
      evidence: { kind: "wrong-amount", text: "wrong amount" },
    });
  });

  it("stays silent when no KPLUS evidence was found", async () => {
    const state = memoryState();
    const finalizer = await recordRoundActivity(
      job("one"),
      undefined,
      state,
      0,
      "generation-1",
    );
    expect(
      await finalizeRound(finalizer!, state, ROUND_INACTIVITY_SECONDS * 1000),
    ).toEqual({
      status: "finalized",
      evidence: undefined,
    });
  });

  it("makes pending finalizers stale after an immediate pass", async () => {
    const state = memoryState();
    const finalizer = await recordRoundActivity(
      job("one"),
      { kind: "wrong-amount", text: "wrong", job: job("one") },
      state,
      0,
      "generation-1",
    );
    await completeRoundAfterPass(job("two"), state, 10_000);
    expect(
      await finalizeRound(finalizer!, state, ROUND_INACTIVITY_SECONDS * 1000),
    ).toEqual({ status: "stale" });
  });
});
