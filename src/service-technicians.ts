export interface ServiceAreaMention {
  id: number;
  technicianName: string;
  lineUserId: string;
  province: string;
  district: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceAreaMentionInput {
  technicianName: string;
  lineUserId: string;
  province: string;
  district: string;
  enabled: boolean;
}

interface ServiceAreaMentionRow {
  id: number;
  technician_name: string;
  line_user_id: string;
  province: string;
  district: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/i;
const MAX_MENTIONS = 200;

function cleanField(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function validateServiceAreaMention(
  input: ServiceAreaMentionInput,
): ServiceAreaMentionInput {
  const normalized = {
    technicianName: cleanField(input.technicianName, 100),
    lineUserId: cleanField(input.lineUserId, 64),
    province: cleanField(input.province, 80),
    district: cleanField(input.district, 80),
    enabled: Boolean(input.enabled),
  };
  if (!normalized.technicianName) throw new Error("กรุณาระบุชื่อช่าง");
  if (!LINE_USER_ID_PATTERN.test(normalized.lineUserId)) {
    throw new Error("LINE User ID ต้องขึ้นต้นด้วย U และมีอักขระรวม 33 ตัว");
  }
  if (!normalized.province) throw new Error("กรุณาระบุจังหวัด");
  if (!normalized.district) throw new Error("กรุณาระบุอำเภอ");
  return normalized;
}

function mapRow(row: ServiceAreaMentionRow): ServiceAreaMention {
  return {
    id: row.id,
    technicianName: row.technician_name,
    lineUserId: row.line_user_id,
    province: row.province,
    district: row.district,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listServiceAreaMentions(
  db: D1Database,
  enabledOnly = false,
): Promise<ServiceAreaMention[]> {
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  const result = await db.prepare(`SELECT id, technician_name, line_user_id,
      province, district, enabled, created_at, updated_at
    FROM service_area_mentions
    ${where}
    ORDER BY enabled DESC, province, district, technician_name
    LIMIT ?`)
    .bind(MAX_MENTIONS)
    .all<ServiceAreaMentionRow>();
  return result.results.map(mapRow);
}

export async function saveServiceAreaMention(
  db: D1Database,
  input: ServiceAreaMentionInput,
  id?: number,
): Promise<void> {
  const value = validateServiceAreaMention(input);
  if (id === undefined) {
    await db.prepare(`INSERT INTO service_area_mentions
        (technician_name, line_user_id, province, district, enabled)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(
        value.technicianName,
        value.lineUserId,
        value.province,
        value.district,
        value.enabled ? 1 : 0,
      )
      .run();
    return;
  }
  if (!Number.isInteger(id) || id <= 0) throw new Error("รหัสรายการไม่ถูกต้อง");
  const result = await db.prepare(`UPDATE service_area_mentions
      SET technician_name = ?, line_user_id = ?, province = ?, district = ?,
        enabled = ?, updated_at = unixepoch()
      WHERE id = ?`)
    .bind(
      value.technicianName,
      value.lineUserId,
      value.province,
      value.district,
      value.enabled ? 1 : 0,
      id,
    )
    .run();
  if (result.meta.changes === 0) throw new Error("ไม่พบรายการที่ต้องการแก้ไข");
}

export async function deleteServiceAreaMention(
  db: D1Database,
  id: number,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) throw new Error("รหัสรายการไม่ถูกต้อง");
  await db.prepare("DELETE FROM service_area_mentions WHERE id = ?").bind(id).run();
}

export async function getServiceAreaMention(
  db: D1Database,
  id: number,
): Promise<ServiceAreaMention | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.prepare(`SELECT id, technician_name, line_user_id,
      province, district, enabled, created_at, updated_at
    FROM service_area_mentions WHERE id = ?`)
    .bind(id)
    .first<ServiceAreaMentionRow>();
  return row ? mapRow(row) : null;
}
