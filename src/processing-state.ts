import type { ImageJob } from "./types";
import type { StateStore } from "./state-store";

const PROCESSED_IMAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function processedImageKey(job: ImageJob): string {
  return `processed-image:${job.webhookEventId}:${job.messageId}`;
}

export async function isImageProcessed(
  job: ImageJob,
  kv: StateStore,
): Promise<boolean> {
  return (await kv.get(processedImageKey(job))) !== null;
}

export async function markImageProcessed(
  job: ImageJob,
  kv: StateStore,
): Promise<void> {
  await kv.put(processedImageKey(job), "1", {
    expirationTtl: PROCESSED_IMAGE_TTL_SECONDS,
  });
}

export { PROCESSED_IMAGE_TTL_SECONDS };
