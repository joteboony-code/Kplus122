import type { ImageJob } from "./types";

export const AUDIT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type LineDeliveryStatus = "not_applicable" | "pending" | "sent" | "failed";
export type LineDeliveryMethod = "reply" | "push";

export interface InspectionTrace {
  providers: string[];
  providerTimings: Record<string, number>;
  stage?: string;
  observedAmounts?: number[];
  hasKplus?: boolean;
  hasSettlement?: boolean;
  lineDeliveryStatus?: LineDeliveryStatus;
  lineDeliveryMethod?: LineDeliveryMethod;
}

export interface InspectionLogRow {
  id: number;
  created_at: number;
  reference_code: string | null;
  outcome: string;
  stage: string | null;
  provider_chain: string | null;
  provider_timings: string | null;
  observed_amounts: string | null;
  has_kplus: number | null;
  has_settlement: number | null;
  queue_delay_ms: number | null;
  processing_ms: number;
  error: string | null;
  line_delivery_status: LineDeliveryStatus;
  line_delivery_method: LineDeliveryMethod | null;
  line_delivery_updated_at: number | null;
}

function limited(value: string | undefined, length = 500): string | null {
  return value ? value.slice(0, length) : null;
}

export async function recordInspectionLog(
  db: D1Database,
  job: ImageJob,
  outcome: "pass" | "fail" | "ignored" | "error",
  trace: InspectionTrace,
  startedAt: number,
  error?: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO inspection_logs (
      webhook_event_id, message_id, conversation_id, sender_user_id,
      reference_code, outcome, stage, provider_chain, provider_timings,
      observed_amounts, has_kplus, has_settlement, queue_delay_ms,
      processing_ms, error, line_delivery_status, line_delivery_method,
      line_delivery_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        job.webhookEventId,
        job.messageId,
        job.replyTarget ?? null,
        job.senderUserId ?? null,
        job.referenceCode ?? null,
        outcome,
        limited(trace.stage, 120),
        trace.providers.join(" > ") || null,
        JSON.stringify(trace.providerTimings),
        trace.observedAmounts ? JSON.stringify(trace.observedAmounts) : null,
        trace.hasKplus === undefined ? null : Number(trace.hasKplus),
        trace.hasSettlement === undefined ? null : Number(trace.hasSettlement),
        job.timestamp ? Math.max(0, startedAt - job.timestamp) : null,
        Math.max(0, now - startedAt),
        limited(error),
        trace.lineDeliveryStatus ?? "not_applicable",
        trace.lineDeliveryMethod ?? null,
        trace.lineDeliveryStatus && trace.lineDeliveryStatus !== "not_applicable"
          ? Math.floor(now / 1000)
          : null,
      ),
    db.prepare("DELETE FROM inspection_logs WHERE created_at < unixepoch() - ?")
      .bind(AUDIT_RETENTION_SECONDS),
  ]);
}

export async function listInspectionLogs(
  db: D1Database,
  limit = 50,
): Promise<InspectionLogRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await db.prepare(`SELECT
      id, created_at, reference_code, outcome, stage, provider_chain,
      provider_timings, observed_amounts, has_kplus, has_settlement,
      queue_delay_ms, processing_ms, error, line_delivery_status,
      line_delivery_method, line_delivery_updated_at
    FROM inspection_logs
    ORDER BY id DESC
    LIMIT ?`)
    .bind(safeLimit)
    .all<InspectionLogRow>();
  return result.results;
}

export async function updateLineDeliveryStatus(
  db: D1Database,
  messageId: string,
  status: LineDeliveryStatus,
  method: LineDeliveryMethod | null,
): Promise<void> {
  await db.prepare(`UPDATE inspection_logs
    SET line_delivery_status = ?,
        line_delivery_method = ?,
        line_delivery_updated_at = unixepoch()
    WHERE message_id = ?`)
    .bind(status, method, messageId)
    .run();
}

export async function clearInspectionLogs(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM inspection_logs").run();
}

export async function purgeExpiredInspectionLogs(
  db: D1Database,
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM inspection_logs WHERE created_at < unixepoch() - ?")
    .bind(AUDIT_RETENTION_SECONDS)
    .run();
  return result.meta.changes;
}
