import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDailyStats, incrementDailyStat } from "../src/daily-stats";

describe("daily processing stats", () => {
  it("tracks counters by Bangkok calendar day", async () => {
    const counters = env.OPERATIONAL_COUNTERS;
    const dayOne = new Date("2026-07-15T16:59:00.000Z");
    const dayTwo = new Date("2026-07-15T17:01:00.000Z");

    await incrementDailyStat(counters, "received", dayOne);
    await incrementDailyStat(counters, "received", dayOne);
    await incrementDailyStat(counters, "passed", dayOne);
    expect(await getDailyStats(counters, dayOne)).toMatchObject({ received: 2, passed: 1 });
    expect(await getDailyStats(counters, dayTwo)).toMatchObject({ received: 0, passed: 0 });
  });

  it("does not lose concurrent increments", async () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        incrementDailyStat(env.OPERATIONAL_COUNTERS, "received", now)),
    );
    expect((await getDailyStats(env.OPERATIONAL_COUNTERS, now)).received).toBe(20);
  });
});
