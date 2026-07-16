import { describe, expect, it } from "vitest";
import { updateLineDeliveryStatus } from "../src/audit-log";

describe("inspection audit log", () => {
  it("updates the LINE delivery status for the source image", async () => {
    let sql = "";
    let parameters: unknown[] = [];
    const db = {
      prepare: (statementSql: string) => {
        sql = statementSql;
        const statement = {
          bind: (...values: unknown[]) => {
            parameters = values;
            return statement;
          },
          run: async () => ({ success: true }),
        };
        return statement;
      },
    } as unknown as D1Database;

    await updateLineDeliveryStatus(db, "message-1", "sent", "push");

    expect(sql).toContain("UPDATE inspection_logs");
    expect(sql).toContain("line_delivery_updated_at = unixepoch()");
    expect(parameters).toEqual(["sent", "push", "message-1"]);
  });
});
