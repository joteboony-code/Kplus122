import { describe, expect, it } from "vitest";
import {
  getJobReference,
  jobReferenceKey,
  storeJobReference,
} from "../src/job-reference";
import type { StateStore } from "../src/state-store";

function memoryState(): StateStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

describe("8-digit job references", () => {
  it("stores references separately for each conversation and sender", async () => {
    const state = memoryState();
    await storeJobReference("G1", "U1", "12345678", state);
    await storeJobReference("G1", "U2", "87654321", state);

    expect(jobReferenceKey("G1", "U1")).not.toBe(jobReferenceKey("G1", "U2"));
    expect(await getJobReference("G1", "U1", state)).toBe("12345678");
    expect(await getJobReference("G1", "U2", state)).toBe("87654321");
  });

  it("rejects non-exact references", async () => {
    await expect(storeJobReference("G1", "U1", "1234", memoryState()))
      .rejects.toThrow("exactly 8 digits");
  });
});
