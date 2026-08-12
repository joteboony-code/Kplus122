import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  claimRoundFailure,
  claimRoundPass,
  claimRoundStock,
  completeRoundAfterFailure,
  completeRoundFinalization,
  completeRoundAfterPass,
  completeRoundImage,
  completeRoundReplyToken,
  completeRoundStock,
  finalizeRound,
  registerRoundImage,
  receiptRoundKey,
  recordRoundActivity,
  recordRoundReplyToken,
  selectLatestRoundReplyToken,
  releaseRoundFinalization,
  releaseRoundFailure,
  releaseRoundPass,
  releaseRoundStock,
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
  it("uses a 30-second inactivity window", () => {
    expect(ROUND_INACTIVITY_SECONDS).toBe(30);
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
    expect(await finalizeRound(second!, state, 40_000)).toEqual({
      status: "waiting",
      retryAfterSeconds: 1,
    });
    expect((await finalizeRound(second!, state, 41_000)).status).toBe("finalized");
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

  it("returns the latest image for a delayed Stock reply when no KPLUS evidence was found", async () => {
    const state = memoryState();
    const lastImage = job("one");
    const finalizer = await recordRoundActivity(
      lastImage,
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
      job: lastImage,
    });
  });

  it("waits for every received image before finalizing one Stock reply", async () => {
    const state = memoryState();
    const firstImage = { ...job("first"), timestamp: 1_000 };
    const lastImage = { ...job("last"), timestamp: 5_000 };
    await registerRoundImage(firstImage, state, firstImage.timestamp, "first");
    const finalizer = await registerRoundImage(lastImage, state, lastImage.timestamp, "last");

    expect(await finalizeRound(finalizer!, state, 34_000)).toEqual({
      status: "waiting",
      retryAfterSeconds: 1,
    });
    await completeRoundImage(firstImage, state);
    expect(await finalizeRound(finalizer!, state, 34_000)).toEqual({
      status: "waiting",
      retryAfterSeconds: 1,
    });
    await completeRoundImage(lastImage, state);
    expect(await finalizeRound(finalizer!, state, 35_000)).toMatchObject({
      status: "finalized",
      job: lastImage,
    });
  });

  it("selects the newest unused Reply token for the same Tid and never crosses Tids", async () => {
    const state = memoryState();
    const first = {
      ...job("first"),
      referenceCode: "28401904",
      replyTokenReceivedAtMs: 1_000,
    };
    const latest = {
      ...job("latest"),
      referenceCode: "28401904",
      replyTokenReceivedAtMs: 2_000,
    };
    const otherTid = {
      ...job("other-tid"),
      referenceCode: "28253121",
      replyTokenReceivedAtMs: 3_000,
    };

    await recordRoundReplyToken(first, state);
    await recordRoundReplyToken(latest, state);
    await recordRoundReplyToken(otherTid, state);

    expect(await selectLatestRoundReplyToken(latest, state)).toEqual({
      messageId: "latest",
      replyToken: "reply-latest",
      receivedAtMs: 2_000,
    });

    await completeRoundReplyToken(latest, "latest", state, 4_000);
    expect(await selectLatestRoundReplyToken(first, state)).toEqual({
      messageId: "first",
      replyToken: "reply-first",
      receivedAtMs: 1_000,
    });
    expect(await selectLatestRoundReplyToken(otherTid, state)).toEqual({
      messageId: "other-tid",
      replyToken: "reply-other-tid",
      receivedAtMs: 3_000,
    });
  });

  it("finalizes an image set immediately after every item finishes", async () => {
    const state = memoryState();
    const first = {
      ...job("album-1"),
      imageSetId: "album-1",
      imageSetIndex: 1,
      imageSetTotal: 2,
    };
    const second = {
      ...job("album-2"),
      imageSetId: "album-1",
      imageSetIndex: 2,
      imageSetTotal: 2,
    };
    await registerRoundImage(first, state, 1_000, "generation-1");
    await completeRoundImage(first, state);
    const finalizer = await registerRoundImage(second, state, 2_000, "generation-2");
    await completeRoundImage(second, state);

    expect(await finalizeRound(finalizer!, state, 2_001)).toMatchObject({
      status: "finalized",
      job: second,
    });
  });

  it("schedules only one finalizer for images in the same generation", async () => {
    const state = memoryState();
    const first = { ...job("same-generation-1"), timestamp: 1_000 };
    const second = { ...job("same-generation-2"), timestamp: 900 };

    expect(await registerRoundImage(first, state, 1_000, "generation-1"))
      .not.toBeNull();
    expect(await registerRoundImage(second, state, 1_001, "generation-2"))
      .toBeNull();
  });

  it("uses the last image event time and keeps its Reply token for delayed Stock", async () => {
    const state = memoryState();
    const firstImage = { ...job("first"), timestamp: 1_000 };
    const lastImage = { ...job("last"), timestamp: 8_000 };
    await recordRoundActivity(
      firstImage,
      undefined,
      state,
      firstImage.timestamp,
      "generation-first",
    );
    const finalizer = await recordRoundActivity(
      lastImage,
      undefined,
      state,
      lastImage.timestamp,
      "generation-last",
    );

    expect(await finalizeRound(finalizer!, state, 37_999)).toEqual({
      status: "waiting",
      retryAfterSeconds: 1,
    });
    expect(await finalizeRound(finalizer!, state, 38_000)).toEqual({
      status: "finalized",
      evidence: undefined,
      job: lastImage,
    });
  });

  it("does not restart the quiet timer for an image that arrived before the latest image", async () => {
    const state = memoryState();
    const latest = { ...job("latest"), timestamp: 10_000 };
    const older = { ...job("older"), timestamp: 5_000 };
    const finalizer = await recordRoundActivity(
      latest,
      undefined,
      state,
      latest.timestamp,
      "generation-latest",
    );

    expect(await recordRoundActivity(
      older,
      undefined,
      state,
      older.timestamp,
      "generation-older",
    )).toBeNull();
    expect(await finalizeRound(finalizer!, state, 40_000)).toMatchObject({
      status: "finalized",
      job: latest,
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

  it("allows only one immediate failure reply per sender and job", async () => {
    const state = memoryState();
    const first = { ...job("fail-one"), referenceCode: "12345678" };
    const second = { ...job("fail-two"), referenceCode: "12345678" };

    expect(await claimRoundFailure(first, state, 10_000)).toBe("acquired");
    expect(await claimRoundFailure(second, state, 10_001)).toBe("suppressed");
    await completeRoundAfterFailure(first, state, 10_002);
    expect(await claimRoundFailure(second, state, 10_003)).toBe("suppressed");
  });

  it("keeps interleaved technicians and job references independent", async () => {
    const state = memoryState();
    const technicianOne = { ...job("u1", "U1"), referenceCode: "12345678" };
    const technicianTwo = { ...job("u2", "U2"), referenceCode: "87654321" };

    expect(await Promise.all([
      claimRoundFailure(technicianOne, state, 10_000),
      claimRoundFailure(technicianTwo, state, 10_000),
    ])).toEqual(["acquired", "acquired"]);
    expect(receiptRoundKey(technicianOne)).not.toBe(receiptRoundKey(technicianTwo));
  });

  it("allows a corrected pass after an immediate failure reply", async () => {
    const state = memoryState();
    const failed = { ...job("wrong"), referenceCode: "12345678" };
    const corrected = { ...job("correct"), referenceCode: "12345678" };

    expect(await claimRoundFailure(failed, state, 10_000)).toBe("acquired");
    await completeRoundAfterFailure(failed, state, 10_001);
    expect(await claimRoundPass(corrected, state, 10_002)).toBe("acquired");
  });

  it("does not send pass and fail replies concurrently for one round", async () => {
    const state = memoryState();
    const failing = job("wrong");
    const passing = job("correct");

    expect(await claimRoundFailure(failing, state, 10_000)).toBe("acquired");
    expect(await claimRoundPass(passing, state, 10_001)).toBe("suppressed");
    await releaseRoundFailure(failing, state);
    expect(await claimRoundPass(passing, state, 10_002)).toBe("acquired");
    expect(await claimRoundFailure(failing, state, 10_003)).toBe("suppressed");
  });

  it("releases a failed immediate failure delivery so it can retry", async () => {
    const state = memoryState();
    const failed = job("wrong");
    expect(await claimRoundFailure(failed, state, 10_000)).toBe("acquired");
    await releaseRoundFailure(failed, state);
    expect(await claimRoundFailure(failed, state, 10_001)).toBe("acquired");
  });

  it("releases a failed pass delivery so the same image can retry", async () => {
    const state = memoryState();
    const pass = job("pass-one");
    expect(await claimRoundPass(pass, state, 10_000)).toBe("acquired");
    await releaseRoundPass(pass, state);
    expect(await claimRoundPass(pass, state, 10_001)).toBe("acquired");
  });

  it("allows only one Stock Flex reply per sender round", async () => {
    const state = memoryState();
    const first = job("stock-one");
    const second = job("stock-two");

    expect(await claimRoundStock(first, state, 10_000)).toBe("acquired");
    expect(await claimRoundStock(second, state, 10_001)).toBe("suppressed");
    await completeRoundStock(first, state, 10_002);
    expect(await claimRoundStock(second, state, 10_003)).toBe("suppressed");
  });

  it("releases a failed Stock Flex delivery so another image can retry", async () => {
    const state = memoryState();
    const first = job("stock-failed");
    const second = job("stock-retry");

    expect(await claimRoundStock(first, state, 10_000)).toBe("acquired");
    await releaseRoundStock(first, state);
    expect(await claimRoundStock(second, state, 10_001)).toBe("acquired");
  });

  it("keeps Stock Flex suppressed for later images with the same Tid", async () => {
    const state = memoryState();
    const first = { ...job("stock-old"), referenceCode: "62777124" };
    const later = { ...job("stock-later"), referenceCode: "62777124" };

    expect(await claimRoundStock(first, state, 10_000)).toBe("acquired");
    await completeRoundStock(first, state, 10_001);
    expect(await claimRoundStock(later, state, 10 * 60 * 1000)).toBe("suppressed");
  });

  it("does not reopen a Stock-completed Tid when a later image finishes", async () => {
    const state = memoryState();
    const first = { ...job("stock-first"), referenceCode: "62777124" };
    const later = { ...job("stock-later"), referenceCode: "62777124" };

    expect(await claimRoundStock(first, state, 10_000)).toBe("acquired");
    await completeRoundStock(first, state, 10_001);
    expect(await recordRoundActivity(
      later,
      undefined,
      state,
      10_002,
      "late-image",
    )).toBeNull();
    expect(await registerRoundImage(
      later,
      state,
      10_002,
      "late-image",
    )).toBeNull();
  });

  it("allows Stock Flex again after the technician sends a new Tid", async () => {
    const state = memoryState();
    const first = { ...job("stock-old"), referenceCode: "62777124" };
    const nextTid = { ...job("stock-new"), referenceCode: "62777125" };

    expect(await claimRoundStock(first, state, 10_000)).toBe("acquired");
    await completeRoundStock(first, state, 10_001);
    expect(await claimRoundStock(nextTid, state, 10 * 60 * 1000)).toBe("acquired");
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

    expect((await finalizeRound(finalizer!, state, 30_000)).status).toBe("finalized");
    expect((await finalizeRound(finalizer!, state, 30_001)).status).toBe("busy");
    await releaseRoundFinalization(finalizer!, state);
    expect((await finalizeRound(finalizer!, state, 30_002)).status).toBe("finalized");
    await completeRoundFinalization(finalizer!, state);
    expect(await finalizeRound(finalizer!, state, 30_004)).toEqual({ status: "stale" });
  });

  it("accepts a corrected pass immediately after a failed round was delivered", async () => {
    const state = memoryState();
    const finalizer = await recordRoundActivity(
      job("wrong"),
      { kind: "wrong-amount", text: "wrong", job: job("wrong") },
      state,
      0,
      "failed-generation",
    );

    expect((await finalizeRound(finalizer!, state, 30_000)).status).toBe("finalized");
    await completeRoundFinalization(finalizer!, state);

    expect(await claimRoundPass(job("correct"), state, 20_001)).toBe("acquired");
  });

  it("keeps suppressing another pass after a successful pass", async () => {
    const state = memoryState();
    await completeRoundAfterPass(job("first-pass"), state, 20_000);

    expect(await claimRoundPass(job("second-pass"), state, 20_001)).toBe("suppressed");
  });
});
