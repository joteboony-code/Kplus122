import type { ImageJob } from "./types";

export const RECENT_PASS_TTL_SECONDS = 60;

export function recentPassKey(job: ImageJob): string | null {
  const conversationId = job.replyTarget;
  const senderId = job.senderUserId ?? job.replyTarget;
  if (!conversationId || !senderId) return null;
  const round = job.imageSetId ? `image-set:${job.imageSetId}` : "fallback";
  return `recent-pass:v2:${conversationId}:${senderId}:${round}`;
}

export async function hasRecentPass(
  job: ImageJob,
  state: KVNamespace,
): Promise<boolean> {
  const key = recentPassKey(job);
  if (!key) return false;
  return (await state.get(key)) !== null;
}

export async function recordRecentPass(
  job: ImageJob,
  state: KVNamespace,
): Promise<void> {
  const key = recentPassKey(job);
  if (!key) return;
  await state.put(key, "1", { expirationTtl: RECENT_PASS_TTL_SECONDS });
}
