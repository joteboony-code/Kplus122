import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  getGoogleVisionUsage,
  hasGoogleVisionCapacity,
  reserveGoogleVisionRequest,
} from "../src/google-vision-usage";

describe("Google Vision monthly usage estimate", () => {
  it("counts successful requests within the Bangkok calendar month", async () => {
    const counters = env.OPERATIONAL_COUNTERS;
    const july = new Date("2026-07-31T16:59:00.000Z");
    const august = new Date("2026-07-31T17:01:00.000Z");

    expect((await reserveGoogleVisionRequest(counters, july)).value).toBe(1);
    expect((await reserveGoogleVisionRequest(counters, july)).value).toBe(2);
    expect(await getGoogleVisionUsage(counters, july)).toBe(2);
    expect(await getGoogleVisionUsage(counters, august)).toBe(0);
  });

  it("stops calls at the configured monthly safety ceiling", async () => {
    const july = new Date("2026-07-15T00:00:00.000Z");
    await env.OPERATIONAL_COUNTERS
      .getByName("google-vision:2026-07")
      .setAtLeast("usage", 1_000);

    expect(await hasGoogleVisionCapacity(env.OPERATIONAL_COUNTERS, july)).toBe(false);
    expect((await reserveGoogleVisionRequest(env.OPERATIONAL_COUNTERS, july)).accepted)
      .toBe(false);
  });
});
