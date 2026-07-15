export interface DailyStats {
  received: number;
  processed: number;
  ignored: number;
  passed: number;
  failed: number;
  duplicates: number;
  errors: number;
  ocrSpaceCalls: number;
  ocrSpaceErrors: number;
  workersAiCalls: number;
  workersAiErrors: number;
  googleVisionCalls: number;
  googleVisionErrors: number;
  googleVisionCapSkips: number;
}

export type DailyStatName = keyof DailyStats;
const STATS_KEY_PREFIX = "daily-stats:";

const EMPTY_STATS: DailyStats = {
  received: 0,
  processed: 0,
  ignored: 0,
  passed: 0,
  failed: 0,
  duplicates: 0,
  errors: 0,
  ocrSpaceCalls: 0,
  ocrSpaceErrors: 0,
  workersAiCalls: 0,
  workersAiErrors: 0,
  googleVisionCalls: 0,
  googleVisionErrors: 0,
  googleVisionCapSkips: 0,
};

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

function statsKey(now: Date): string {
  return `${STATS_KEY_PREFIX}${bangkokDate(now)}`;
}

export async function getDailyStats(
  kv: KVNamespace,
  now = new Date(),
): Promise<DailyStats> {
  const stored = await kv.get<Partial<DailyStats>>(statsKey(now), "json");
  const result = { ...EMPTY_STATS };
  if (!stored) return result;
  for (const name of Object.keys(result) as DailyStatName[]) {
    const value = stored[name];
    if (Number.isInteger(value) && (value ?? -1) >= 0) result[name] = value ?? 0;
  }
  return result;
}

export async function incrementDailyStat(
  kv: KVNamespace,
  name: DailyStatName,
  now = new Date(),
): Promise<number> {
  const stats = await getDailyStats(kv, now);
  stats[name] += 1;
  await kv.put(statsKey(now), JSON.stringify(stats), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
  return stats[name];
}
