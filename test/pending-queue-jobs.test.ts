import { describe, expect, it } from "vitest";
import {
  isCurrentQueueJobDay,
  pendingQueueItem,
  pendingQueueKey,
} from "../src/pending-queue-jobs";
import type { ImageJob } from "../src/types";

function job(messageId: string): ImageJob {
  return {
    webhookEventId: `event-${messageId}`,
    messageId,
    replyToken: `reply-${messageId}`,
    replyTarget: "G1",
    senderUserId: "U1",
    referenceCode: "28401904",
  };
}

describe("pending queue jobs", () => {
  it("deduplicates a deferred image by webhook and message id", () => {
    const first = job("image-1");
    const retry = { ...first };
    expect(pendingQueueKey("images", first)).toBe(
      pendingQueueKey("images", retry),
    );
  });

  it("keeps the target, body, and error for quota recovery", () => {
    const item = pendingQueueItem(
      "images",
      job("image-2"),
      new Error("daily write operations limit"),
      1_000,
    );
    expect(item).toMatchObject({
      target: "images",
      attempts: 0,
      lastError: "daily write operations limit",
      body: { messageId: "image-2", referenceCode: "28401904" },
    });
    expect(item.nextAttemptAt).toBeGreaterThan(1_000);
  });

  it("expires deferred images after the Bangkok calendar day ends", () => {
    const deferred = {
      ...job("image-3"),
      timestamp: Date.parse("2026-07-28T16:59:59.000Z"),
    };
    expect(isCurrentQueueJobDay(deferred, Date.parse("2026-07-28T17:00:00.000Z"))).toBe(false);
    expect(isCurrentQueueJobDay(deferred, Date.parse("2026-07-28T16:59:59.000Z"))).toBe(true);
  });
});
