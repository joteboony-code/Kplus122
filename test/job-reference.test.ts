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

  it("resolves the TID that was active when an image was sent", async () => {
    const state = memoryState();
    await storeJobReference("G1", "U1", "28401904", state, 1_000);
    await storeJobReference("G1", "U1", "28253121", state, 2_000);

    expect(await getJobReference("G1", "U1", state, 1_500)).toBe("28401904");
    expect(await getJobReference("G1", "U1", state, 2_500)).toBe("28253121");
  });

  it("keeps the latest TID behavior when no event timestamp is available", async () => {
    const state = memoryState();
    await storeJobReference("G1", "U1", "28401904", state);
    await storeJobReference("G1", "U1", "28253121", state);

    expect(await getJobReference("G1", "U1", state)).toBe("28253121");
  });
});
