import { describe, expect, it } from "vitest";
import {
  claimImageQueue,
  isImageProcessed,
  markImageProcessed,
  releaseImageQueueClaim,
  processedImageKey,
} from "../src/processing-state";
import type { ImageJob } from "../src/types";
import type { StateStore } from "../src/state-store";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  } as KVNamespace;
}

const job: ImageJob = {
  webhookEventId: "event-1",
  messageId: "image-1",
  replyToken: "reply-1",
};

describe("processed image idempotency", () => {
  it("uses both the webhook event and LINE message IDs", () => {
    expect(processedImageKey(job)).toBe("processed-image:event-1:image-1");
  });

  it("suppresses a job only after it is marked processed", async () => {
    const kv = memoryKv();
    expect(await isImageProcessed(job, kv)).toBe(false);
    await markImageProcessed(job, kv);
    expect(await isImageProcessed(job, kv)).toBe(true);
  });

  it("claims a queue write once and releases a failed claim", async () => {
    const kv = memoryKv();
    const state = kv as unknown as StateStore;
    expect(await claimImageQueue(job, state)).toBe(true);
    expect(await claimImageQueue(job, state)).toBe(false);
    await releaseImageQueueClaim(job, state);
    expect(await claimImageQueue(job, state)).toBe(true);
  });
});
