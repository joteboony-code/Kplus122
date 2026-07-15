const OCR_SPACE_DAILY_LIMIT = 500;
const USAGE_KEY_PREFIX = "ocr-space:usage:";

function bangkokDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function usageKey(now: Date): string {
  return `${USAGE_KEY_PREFIX}${bangkokDate(now)}`;
}

export async function getOcrSpaceUsage(
  kv: KVNamespace,
  now = new Date(),
): Promise<number> {
  const stored = Number(await kv.get(usageKey(now)) ?? "0");
  return Number.isInteger(stored) && stored >= 0 ? stored : 0;
}

export async function hasOcrSpaceCapacity(
  kv: KVNamespace,
  now = new Date(),
): Promise<boolean> {
  return (await getOcrSpaceUsage(kv, now)) < OCR_SPACE_DAILY_LIMIT;
}

export async function recordOcrSpaceRequest(
  kv: KVNamespace,
  now = new Date(),
): Promise<number> {
  const next = Math.min((await getOcrSpaceUsage(kv, now)) + 1, OCR_SPACE_DAILY_LIMIT);
  await kv.put(usageKey(now), String(next), { expirationTtl: 3 * 24 * 60 * 60 });
  return next;
}

export async function markOcrSpaceQuotaExhausted(
  kv: KVNamespace,
  now = new Date(),
): Promise<void> {
  await kv.put(usageKey(now), String(OCR_SPACE_DAILY_LIMIT), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
}

export { OCR_SPACE_DAILY_LIMIT };
