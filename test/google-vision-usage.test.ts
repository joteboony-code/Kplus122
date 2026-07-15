import { describe, expect, it } from "vitest";
import {
  getGoogleVisionUsage,
  hasGoogleVisionCapacity,
  recordGoogleVisionRequest,
} from "../src/google-vision-usage";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
  } as KVNamespace;
}

describe("Google Vision monthly usage estimate", () => {
  it("counts successful requests within the Bangkok calendar month", async () => {
    const kv = memoryKv();
    const july = new Date("2026-07-31T16:59:00.000Z");
    const august = new Date("2026-07-31T17:01:00.000Z");

    expect(await recordGoogleVisionRequest(kv, july)).toBe(1);
    expect(await recordGoogleVisionRequest(kv, july)).toBe(2);
    expect(await getGoogleVisionUsage(kv, july)).toBe(2);
    expect(await getGoogleVisionUsage(kv, august)).toBe(0);
  });

  it("stops calls at the configured monthly safety ceiling", async () => {
    const kv = memoryKv();
    for (let count = 0; count < 1_000; count += 1) {
      await recordGoogleVisionRequest(kv);
    }
    expect(await hasGoogleVisionCapacity(kv)).toBe(false);
  });
});
