import type { StateStore } from "./state-store";

const REFERENCE_TTL_SECONDS = 30 * 60;

export function jobReferenceKey(conversationId: string, senderId: string): string {
  return `job-reference:v1:${conversationId}:${senderId}`;
}

export async function storeJobReference(
  conversationId: string,
  senderId: string,
  referenceCode: string,
  state: StateStore,
): Promise<void> {
  if (!/^\d{8}$/.test(referenceCode)) {
    throw new Error("Job reference must contain exactly 8 digits");
  }
  await state.put(jobReferenceKey(conversationId, senderId), referenceCode, {
    expirationTtl: REFERENCE_TTL_SECONDS,
  });
}

export async function getJobReference(
  conversationId: string,
  senderId: string,
  state: StateStore,
): Promise<string | undefined> {
  const value = await state.get(jobReferenceKey(conversationId, senderId));
  return value && /^\d{8}$/.test(value) ? value : undefined;
}
