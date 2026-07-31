import { describe, expect, it } from "vitest";
import { recordInspectionLog, updateLineDeliveryStatus } from "../src/audit-log";

describe("inspection audit log", () => {
  it("stores a bounded PaddleOCR text result for the control page", async () => {
    const prepared: Array<{ sql: string; parameters: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => {
        const entry = { sql, parameters: [] as unknown[] };
        prepared.push(entry);
        const statement = {
          bind: (...parameters: unknown[]) => {
            entry.parameters = parameters;
            return statement;
          },
        };
        return statement;
      },
      batch: async () => [],
    } as unknown as D1Database;
    const paddleText = `KPLUS\nSETTLEMENT\n${"1".repeat(5_000)}`;

    await recordInspectionLog(
      db,
      {
        webhookEventId: "event-1",
        messageId: "message-1",
        replyToken: "reply-1",
        referenceCode: "12345678",
      },
      "pass",
      {
        providers: ["paddleocr"],
        providerTimings: { "paddleocr-poll": 420 },
        paddleOcrText: paddleText,
      },
      Date.now(),
    );

    expect(prepared[0].sql).toContain("paddle_ocr_text");
    expect(prepared[0].parameters).toContain(paddleText.slice(0, 4_000));
    expect(prepared[0].parameters).not.toContain(paddleText);
  });

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
