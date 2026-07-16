import type {
  CounterIncrementResult,
  OperationalCounterNamespace,
} from "./operational-counters";

export const GOOGLE_VISION_FREE_MONTHLY_UNITS = 1_000;
const COUNTER_NAME = "usage";

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

function counterId(now: Date): string {
  return `google-vision:${bangkokMonth(now)}`;
}

export async function getGoogleVisionUsage(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<number> {
  return counters.getByName(counterId(now)).get(COUNTER_NAME);
}

export async function hasGoogleVisionCapacity(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<boolean> {
  return (await getGoogleVisionUsage(counters, now)) < GOOGLE_VISION_FREE_MONTHLY_UNITS;
}

export async function reserveGoogleVisionRequest(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<CounterIncrementResult> {
  return counters
    .getByName(counterId(now))
    .increment(COUNTER_NAME, GOOGLE_VISION_FREE_MONTHLY_UNITS);
}
