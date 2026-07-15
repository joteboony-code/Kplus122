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
