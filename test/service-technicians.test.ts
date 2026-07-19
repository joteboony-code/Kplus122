import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  deleteServiceAreaMention,
  getServiceAreaMention,
  listServiceAreaMentions,
  saveServiceAreaMention,
  validateServiceAreaMention,
} from "../src/service-technicians";

async function prepareSchema(): Promise<void> {
  await env.CONTROL_DB.prepare(`CREATE TABLE IF NOT EXISTS service_area_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_name TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    province TEXT NOT NULL,
    district TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`).run();
  await env.CONTROL_DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS
    idx_service_area_mentions_unique
    ON service_area_mentions(line_user_id, province, district)`).run();
  await env.CONTROL_DB.prepare("DELETE FROM service_area_mentions").run();
}

const input = {
  technicianName: "ช่างโจ",
  lineUserId: "U285cef534729ee5bcfa1bf4d8e84e323",
  province: "ชลบุรี",
  district: "พานทอง",
  enabled: true,
};

describe("service technician area management", () => {
  beforeEach(prepareSchema);

  it("creates, updates, lists, and deletes an area assignment", async () => {
    await saveServiceAreaMention(env.CONTROL_DB, input);
    const created = (await listServiceAreaMentions(env.CONTROL_DB))[0];
    expect(created).toMatchObject(input);

    await saveServiceAreaMention(env.CONTROL_DB, {
      ...input,
      technicianName: "ช่างโจ พานทอง",
      enabled: false,
    }, created.id);
    expect(await getServiceAreaMention(env.CONTROL_DB, created.id)).toMatchObject({
      technicianName: "ช่างโจ พานทอง",
      enabled: false,
    });
    expect(await listServiceAreaMentions(env.CONTROL_DB, true)).toHaveLength(0);

    await deleteServiceAreaMention(env.CONTROL_DB, created.id);
    expect(await listServiceAreaMentions(env.CONTROL_DB)).toHaveLength(0);
  });

  it("rejects an invalid LINE User ID", () => {
    expect(() => validateServiceAreaMention({
      ...input,
      lineUserId: "28253214",
    })).toThrow("LINE User ID");
  });

  it("prevents duplicate technician and area assignments", async () => {
    await saveServiceAreaMention(env.CONTROL_DB, input);
    await expect(saveServiceAreaMention(env.CONTROL_DB, input)).rejects.toThrow();
  });
});
