import { describe, expect, it } from "vitest";
import {
  handleControlRequest,
  isProcessingEnabled,
  setProcessingEnabled,
} from "../src/control";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
  } as KVNamespace;
}

function memoryControlDb(): D1Database {
  const values = new Map<string, string>();
  return {
    prepare: (sql: string) => {
      let parameters: unknown[] = [];
      const statement = {
        bind: (...valuesToBind: unknown[]) => {
          parameters = valuesToBind;
          return statement;
        },
        first: async () => {
          const value = values.get(String(parameters[0]));
          return value === undefined ? null : { value };
        },
        run: async () => {
          if (sql.includes("INSERT INTO control_state")) {
            values.set(String(parameters[0]), String(parameters[1]));
          }
          return { success: true };
        },
      } as unknown as D1PreparedStatement;
      return statement;
    },
  } as D1Database;
}

function controlDbWithLog(): D1Database {
  const base = memoryControlDb();
  return {
    prepare: (sql: string) => {
      if (!sql.includes("FROM inspection_logs")) return base.prepare(sql);
      const statement = {
        bind: () => statement,
        all: async () => ({
          success: true,
          results: [{
            id: 1,
            created_at: 1_784_133_300,
            webhook_event_id: "event-1",
            message_id: "message-1",
            group_id: "group-1",
            user_id: "user-1",
            reference_code: "28038457",
            outcome: "pass",
            stage: "ocr-space",
            provider_chain: "ocr-space",
            provider_timings: '{"ocr-space":1220}',
            observed_amounts: "[1.22,-1.22]",
            has_kplus: 1,
            has_settlement: 1,
            queue_delay_ms: 250,
            processing_ms: 1562,
            error: null,
          }],
        }),
      } as unknown as D1PreparedStatement;
      return statement;
    },
  } as D1Database;
}

describe("processing control", () => {
  it("defaults to enabled so existing deployments keep working", async () => {
    expect(await isProcessingEnabled(memoryControlDb())).toBe(true);
  });

  it("honors the emergency stop without writing KV", async () => {
    expect(await isProcessingEnabled(memoryControlDb(), true)).toBe(false);
  });

  it("persists disabled and enabled states", async () => {
    const db = memoryControlDb();
    await setProcessingEnabled(db, false);
    expect(await isProcessingEnabled(db)).toBe(false);
    await setProcessingEnabled(db, true);
    expect(await isProcessingEnabled(db)).toBe(true);
  });

  it("requires the configured password and creates an authenticated session", async () => {
    const kv = memoryKv();
    const env = {
      CONTROL_PASSWORD: "strong-test-password",
      CONTROL_DB: memoryControlDb(),
      REPLY_STATE: kv,
    };

    const anonymous = await handleControlRequest(
      new Request("https://example.com/control"),
      env,
    );
    expect(anonymous?.status).toBe(200);
    expect(await anonymous?.text()).toContain("รหัสผ่าน");

    const failed = await handleControlRequest(
      new Request("https://example.com/control/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://example.com",
        },
        body: new URLSearchParams({ password: "wrong" }),
      }),
      env,
    );
    expect(failed?.status).toBe(401);

    const login = await handleControlRequest(
      new Request("https://example.com/control/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://example.com",
        },
        body: new URLSearchParams({ password: env.CONTROL_PASSWORD }),
      }),
      env,
    );
    expect(login?.status).toBe(303);
    const sessionCookie = login?.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(sessionCookie).toMatch(/^kplus_control_session=/);

    const control = await handleControlRequest(
      new Request("https://example.com/control", {
        headers: { Cookie: sessionCookie ?? "" },
      }),
      env,
    );
    expect(control?.status).toBe(200);
    const page = await control?.text();
    expect(page).toContain("กำลังทำงาน");
    expect(page).toContain("OCR.space");
    expect(page).toContain("0 / 500 รูป");
    expect(page).toContain("Workers AI");
    expect(page).toContain("Google Vision");
    expect(page).toContain("SETTLEMENT");
    expect(page).toContain("ตรวจพร้อมกันสูงสุด 2 รูป");
    expect(page).toContain("รับเลขงาน 8 หลักก่อนรูป");
    expect(page).toContain("Log การตรวจล่าสุด 50 รูป");
    expect(page).toContain("0 / 1000 units");
    expect(page).toContain("สถิติวันนี้");
    expect(page).toContain("รูปซ้ำที่กันไว้");
  });

  it("lets an authenticated operator disable processing", async () => {
    const kv = memoryKv();
    const controlDb = memoryControlDb();
    const env = {
      CONTROL_PASSWORD: "strong-test-password",
      CONTROL_DB: controlDb,
      REPLY_STATE: kv,
    };
    const login = await handleControlRequest(
      new Request("https://example.com/control/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://example.com",
        },
        body: new URLSearchParams({ password: env.CONTROL_PASSWORD }),
      }),
      env,
    );
    const sessionCookie = login?.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";

    const toggle = await handleControlRequest(
      new Request("https://example.com/control/toggle", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: sessionCookie,
          Origin: "https://example.com",
        },
        body: new URLSearchParams({ action: "disable" }),
      }),
      env,
    );
    expect(toggle?.status).toBe(303);
    expect(await isProcessingEnabled(controlDb)).toBe(false);
  });

  it("highlights the complete result card and detected evidence", async () => {
    const env = {
      CONTROL_PASSWORD: "strong-test-password",
      CONTROL_DB: controlDbWithLog(),
      REPLY_STATE: memoryKv(),
    };
    const login = await handleControlRequest(
      new Request("https://example.com/control/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://example.com",
        },
        body: new URLSearchParams({ password: env.CONTROL_PASSWORD }),
      }),
      env,
    );
    const sessionCookie = login?.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const control = await handleControlRequest(
      new Request("https://example.com/control", {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    const page = await control?.text();
    expect(page).toContain('class="log-card pass"');
    expect(page).toContain('class="evidence-chip found"><i>✓</i>พบ KPLUS');
    expect(page).toContain('class="evidence-chip found"><i>✓</i>พบ SETTLEMENT');
    expect(page).toContain('class="amount-value">1.22,-1.22');
    expect(page).toContain('class="job-value">28038457');
  });

  it("accepts a browser same-origin form when Origin is serialized as null", async () => {
    const env = {
      CONTROL_PASSWORD: "strong-test-password",
      CONTROL_DB: memoryControlDb(),
      REPLY_STATE: memoryKv(),
    };
    const login = await handleControlRequest(
      new Request("https://example.com/control/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
        },
        body: new URLSearchParams({ password: env.CONTROL_PASSWORD }),
      }),
      env,
    );
    expect(login?.status).toBe(303);
  });
});
