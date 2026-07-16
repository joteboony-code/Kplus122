import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  claimRoundPass,
  completeRoundFinalization,
  completeRoundAfterPass,
  finalizeRound,
  receiptRoundKey,
  recordRoundActivity,
  releaseRoundFinalization,
  releaseRoundPass,
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

  it("separates rounds when the technician sends a new 8-digit job reference", () => {
    expect(receiptRoundKey({ ...job("one"), referenceCode: "12345678" }))
      .not.toBe(receiptRoundKey({ ...job("two"), referenceCode: "87654321" }));
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

  it("does not reopen a completed round when a concurrent failing image finishes later", async () => {
    const state = memoryState();
    await completeRoundAfterPass(job("pass"), state, 10_000);
    expect(await recordRoundActivity(
      job("late-fail"),
      { kind: "wrong-amount", text: "wrong", job: job("late-fail") },
      state,
      12_000,
      "late-generation",
    )).toBeNull();
  });

  it("allows only one concurrent pass owner", async () => {
    const state = memoryState();
    expect(await claimRoundPass(job("pass-one"), state, 10_000)).toBe("acquired");
    expect(await claimRoundPass(job("pass-two"), state, 10_001)).toBe("suppressed");
    expect(await claimRoundPass(job("pass-one"), state, 10_002)).toBe("busy");

    await completeRoundAfterPass(job("pass-one"), state, 10_003);
    expect(await claimRoundPass(job("pass-two"), state, 10_004)).toBe("suppressed");
  });

  it("serializes concurrent pass claims in the Durable Object", async () => {
    const first = job("do-pass-one", "U-DO", "G-DO");
    const second = job("do-pass-two", "U-DO", "G-DO");
    const roundKey = receiptRoundKey(first)!;
    const coordinator = env.RECEIPT_ROUNDS.getByName(roundKey);

    const results = await Promise.all([
      coordinator.claimPass(first),
      coordinator.claimPass(second),
    ]);
    expect(results.sort()).toEqual(["acquired", "suppressed"]);
  });

  it("releases a failed pass delivery so the same image can retry", async () => {
    const state = memoryState();
    const pass = job("pass-one");
    expect(await claimRoundPass(pass, state, 10_000)).toBe("acquired");
    await releaseRoundPass(pass, state);
    expect(await claimRoundPass(pass, state, 10_001)).toBe("acquired");
  });

  it("leases finalization until delivery succeeds or the lease is released", async () => {
    const state = memoryState();
    const finalizer = await recordRoundActivity(
      job("one"),
      { kind: "wrong-amount", text: "wrong", job: job("one") },
      state,
      0,
      "generation-1",
    );

    expect((await finalizeRound(finalizer!, state, 20_000)).status).toBe("finalized");
    expect((await finalizeRound(finalizer!, state, 20_001)).status).toBe("busy");
    await releaseRoundFinalization(finalizer!, state);
    expect((await finalizeRound(finalizer!, state, 20_002)).status).toBe("finalized");
    await completeRoundFinalization(finalizer!, state, 20_003);
    expect(await finalizeRound(finalizer!, state, 20_004)).toEqual({ status: "stale" });
  });
});
