export const GOOGLE_VISION_FREE_MONTHLY_UNITS = 1_000;
const USAGE_KEY_PREFIX = "google-vision:usage:";

function bangkokMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}`;
}

function usageKey(now: Date): string {
  return `${USAGE_KEY_PREFIX}${bangkokMonth(now)}`;
}

export async function getGoogleVisionUsage(
  kv: KVNamespace,
  now = new Date(),
): Promise<number> {
  const stored = Number(await kv.get(usageKey(now)) ?? "0");
  return Number.isInteger(stored) && stored >= 0 ? stored : 0;
}

export async function hasGoogleVisionCapacity(
  kv: KVNamespace,
  now = new Date(),
): Promise<boolean> {
  return (await getGoogleVisionUsage(kv, now)) < GOOGLE_VISION_FREE_MONTHLY_UNITS;
}

export async function recordGoogleVisionRequest(
  kv: KVNamespace,
  now = new Date(),
): Promise<number> {
  const next = (await getGoogleVisionUsage(kv, now)) + 1;
  await kv.put(usageKey(now), String(next), {
    expirationTtl: 62 * 24 * 60 * 60,
  });
  return next;
}
