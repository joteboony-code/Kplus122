import type { ImageJob } from "./types";

export const AUDIT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type LineDeliveryStatus = "not_applicable" | "pending" | "sent" | "failed";
export type LineDeliveryMethod = "reply" | "push";

export interface ProviderFinding {
  kplus: boolean;
  settlement: boolean;
  amounts: number[];
}

export interface InspectionTrace {
  providers: string[];
  providerTimings: Record<string, number>;
  paddleTokenSlot?: 1 | 2;
  paddleOcrText?: string;
  stage?: string;
  observedAmounts?: number[];
  hasKplus?: boolean;
  hasSettlement?: boolean;
  providerFindings?: Record<string, ProviderFinding>;
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
  paddle_ocr_text: string | null;
  observed_amounts: string | null;
  has_kplus: number | null;
  has_settlement: number | null;
  queue_delay_ms: number | null;
  processing_ms: number;
  error: string | null;
  line_delivery_status: LineDeliveryStatus;
  line_delivery_method: LineDeliveryMethod | null;
  line_delivery_updated_at: number | null;
  image_set_id: string | null;
  image_set_index: number | null;
  image_set_total: number | null;
  evidence_json: string | null;
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
  const evidence = JSON.stringify({
    tid: job.referenceCode ?? null,
    outcome,
    providers: trace.providers.slice(0, 8),
    paddleTokenSlot: trace.paddleTokenSlot ?? null,
    kplus: trace.hasKplus ?? null,
    settlement: trace.hasSettlement ?? null,
    amounts: (trace.observedAmounts ?? []).slice(0, 8),
    providerFindings: trace.providerFindings ?? null,
    imageSet: job.imageSetId
      ? {
          id: job.imageSetId,
          index: job.imageSetIndex ?? null,
          total: job.imageSetTotal ?? null,
        }
      : null,
  });
  await db.batch([
    db.prepare(`INSERT INTO inspection_logs (
      webhook_event_id, message_id, conversation_id, sender_user_id,
      reference_code, outcome, stage, provider_chain, provider_timings,
      paddle_ocr_text, observed_amounts, has_kplus, has_settlement, queue_delay_ms,
      processing_ms, error, line_delivery_status, line_delivery_method,
      line_delivery_updated_at, image_set_id, image_set_index, image_set_total,
      evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        limited(trace.paddleOcrText, 4_000),
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
        job.imageSetId ?? null,
        job.imageSetIndex ?? null,
        job.imageSetTotal ?? null,
        evidence.slice(0, 2_000),
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
      provider_timings, paddle_ocr_text, observed_amounts, has_kplus, has_settlement,
      queue_delay_ms, processing_ms, error, line_delivery_status,
      line_delivery_method, line_delivery_updated_at,
      image_set_id, image_set_index, image_set_total, evidence_json
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
