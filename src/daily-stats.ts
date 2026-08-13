import type { OperationalCounterNamespace } from "./operational-counters";

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
  queueWrites: number;
  queueReads: number;
  queueDeletes: number;
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
  queueWrites: 0,
  queueReads: 0,
  queueDeletes: 0,
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

function counterId(now: Date): string {
  return `${STATS_KEY_PREFIX}${bangkokDate(now)}`;
}

export async function getDailyStats(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<DailyStats> {
  const result = { ...EMPTY_STATS };
  const names = Object.keys(result) as DailyStatName[];
  const stored = await counters.getByName(counterId(now)).getMany(names);
  for (const name of Object.keys(result) as DailyStatName[]) {
    const value = stored[name];
    if (Number.isInteger(value) && (value ?? -1) >= 0) result[name] = value ?? 0;
  }
  return result;
}

export async function incrementDailyStat(
  counters: OperationalCounterNamespace,
  name: DailyStatName,
  now = new Date(),
): Promise<number> {
  const result = await counters.getByName(counterId(now)).increment(name);
  return result.value;
}

export async function incrementDailyStatBy(
  counters: OperationalCounterNamespace,
  name: DailyStatName,
  amount: number,
  now = new Date(),
): Promise<number> {
  const result = await counters.getByName(counterId(now)).incrementBy(name, amount);
  return result.value;
}
