import { describe, expect, it } from "vitest";
import { getDailyStats, incrementDailyStat } from "../src/daily-stats";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => { values.set(key, value); },
  } as KVNamespace;
}

describe("daily processing stats", () => {
  it("tracks counters by Bangkok calendar day", async () => {
    const kv = memoryKv();
    const dayOne = new Date("2026-07-15T16:59:00.000Z");
    const dayTwo = new Date("2026-07-15T17:01:00.000Z");

    await incrementDailyStat(kv, "received", dayOne);
    await incrementDailyStat(kv, "received", dayOne);
    await incrementDailyStat(kv, "passed", dayOne);
    expect(await getDailyStats(kv, dayOne)).toMatchObject({ received: 2, passed: 1 });
    expect(await getDailyStats(kv, dayTwo)).toMatchObject({ received: 0, passed: 0 });
  });
});
