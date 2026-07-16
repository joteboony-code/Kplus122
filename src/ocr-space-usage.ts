import type {
  CounterIncrementResult,
  OperationalCounterNamespace,
} from "./operational-counters";

const OCR_SPACE_DAILY_LIMIT = 500;
const COUNTER_NAME = "usage";

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
  return `ocr-space:${bangkokDate(now)}`;
}

export async function getOcrSpaceUsage(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<number> {
  return counters.getByName(counterId(now)).get(COUNTER_NAME);
}

export async function hasOcrSpaceCapacity(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<boolean> {
  return (await getOcrSpaceUsage(counters, now)) < OCR_SPACE_DAILY_LIMIT;
}

export async function reserveOcrSpaceRequest(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<CounterIncrementResult> {
  return counters
    .getByName(counterId(now))
    .increment(COUNTER_NAME, OCR_SPACE_DAILY_LIMIT);
}

export async function markOcrSpaceQuotaExhausted(
  counters: OperationalCounterNamespace,
  now = new Date(),
): Promise<void> {
  await counters
    .getByName(counterId(now))
    .setAtLeast(COUNTER_NAME, OCR_SPACE_DAILY_LIMIT);
}

export { OCR_SPACE_DAILY_LIMIT };
