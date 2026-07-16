import { describe, expect, it, vi } from "vitest";
import { purgeExpiredState } from "../src/state-store";

describe("expired operational state cleanup", () => {
  it("deletes expired D1 rows using the scheduled timestamp", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 7 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

    expect(await purgeExpiredState(db, 123_456)).toBe(7);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM control_state"));
    expect(bind).toHaveBeenCalledWith(123_456);
  });
});
