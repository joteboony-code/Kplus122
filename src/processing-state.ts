import type { ImageJob } from "./types";
import type { StateStore } from "./state-store";

const PROCESSED_IMAGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const QUEUED_IMAGE_TTL_SECONDS = 24 * 60 * 60;

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

export function queuedImageKey(job: ImageJob): string {
  return `queued-image:${job.webhookEventId}:${job.messageId}`;
}

/** Claim an image before writing to Queue so duplicate LINE deliveries do not
 * create another Queue operation. The claim remains through deferred storage.
 */
export async function claimImageQueue(
  job: ImageJob,
  state: StateStore,
): Promise<boolean> {
  const key = queuedImageKey(job);
  if (await state.get(key)) return false;
  await state.put(key, "claim", { expirationTtl: QUEUED_IMAGE_TTL_SECONDS });
  return true;
}

export async function markImageQueued(
  job: ImageJob,
  state: StateStore,
): Promise<void> {
  await state.put(queuedImageKey(job), "queued", {
    expirationTtl: QUEUED_IMAGE_TTL_SECONDS,
  });
}

export async function releaseImageQueueClaim(
  job: ImageJob,
  state: StateStore,
): Promise<void> {
  const key = queuedImageKey(job);
  if ((await state.get(key)) === "claim") await state.delete(key);
}

export { PROCESSED_IMAGE_TTL_SECONDS, QUEUED_IMAGE_TTL_SECONDS };
