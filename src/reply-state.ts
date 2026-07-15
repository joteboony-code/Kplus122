import type { ImageJob } from "./types";
import type { StateStore } from "./state-store";

export const RECENT_PASS_TTL_SECONDS = 60;
export const IMAGE_SET_PASS_TTL_SECONDS = 60 * 60;

export function recentPassTtl(job: ImageJob): number {
  return job.imageSetId ? IMAGE_SET_PASS_TTL_SECONDS : RECENT_PASS_TTL_SECONDS;
}

export function recentPassKey(job: ImageJob): string | null {
  const conversationId = job.replyTarget;
  const senderId = job.senderUserId ?? job.replyTarget;
  if (!conversationId || !senderId) return null;
  const round = job.imageSetId ? `image-set:${job.imageSetId}` : "fallback";
  return `recent-pass:v2:${conversationId}:${senderId}:${round}`;
}

export async function hasRecentPass(
  job: ImageJob,
  state: StateStore,
): Promise<boolean> {
  const key = recentPassKey(job);
  if (!key) return false;
  return (await state.get(key)) !== null;
}

export async function recordRecentPass(
  job: ImageJob,
  state: StateStore,
): Promise<void> {
  const key = recentPassKey(job);
  if (!key) return;
  await state.put(key, "1", { expirationTtl: recentPassTtl(job) });
}
