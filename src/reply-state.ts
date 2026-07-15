import type { ImageJob } from "./types";
import type { StateStore } from "./state-store";

export const RECENT_PASS_TTL_SECONDS = 60;

export function recentPassTtl(_job: ImageJob): number {
  return RECENT_PASS_TTL_SECONDS;
}

export function recentPassKey(job: ImageJob): string | null {
  const conversationId = job.replyTarget;
  const senderId = job.senderUserId ?? job.replyTarget;
  if (!conversationId || !senderId) return null;
  return `recent-pass:v4:${conversationId}:${senderId}:${job.referenceCode ?? "no-reference"}`;
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
