import {
  acceptWorkerPaymentName,
  classifyKplusVisualCandidate,
  combineReceiptEvidence,
  decideReceipt,
  formatKplusSuccess,
  formatDecision,
  hasGoogleCandidateTextEvidence,
  hasThaiQrPaymentText,
  hasWrongAmountConsensus,
  inspectConfirmedReceiptText,
  inspectReceiptText,
  hasExpectedAmount,
  routeOcrSpaceDecision,
  routePaddleOcrDecision,
  shouldContinueToGoogleVision,
  shouldReplyAfterGoogleVision,
  transcribeVisibleText,
} from "./analyze";
import { googleVisionOcr } from "./google-vision";
import {
  reserveGoogleVisionRequest,
} from "./google-vision-usage";
import {
  incrementDailyStat,
  incrementDailyStatBy,
  type DailyStatName,
} from "./daily-stats";
import { ocrSpaceOcr } from "./ocr-space";
import {
  markOcrSpaceQuotaExhausted,
  reserveOcrSpaceRequest,
} from "./ocr-space-usage";
import { handleControlRequest, isProcessingEnabled } from "./control";
import {
  purgeExpiredInspectionLogs,
  recordInspectionLog,
  updateLineDeliveryStatus,
  type LineDeliveryMethod,
  type InspectionTrace,
} from "./audit-log";
import { getJobReference, storeJobReference } from "./job-reference";
import {
  bindImageSetReference,
  getImageSetReference,
  purgeExpiredImageSetBindings,
} from "./image-set-binding";
import {
  conversationAndSenderFromEvent,
  downloadLineImage,
  imageJobFromEvent,
  referenceCodeFromEvent,
  sendReplyMessages,
  sendInspectionResultWithMethod,
  serviceLookContextFromEvent,
  stockFlexMessage,
  verifyLineSignature,
  type ServiceLookContext,
} from "./line";
import { hasRecentPass, recordRecentPass } from "./reply-state";
import {
  claimImageQueue,
  isImageProcessed,
  markImageProcessed,
  purgeStaleImageQueueMarkers,
  releaseImageQueueClaim,
} from "./processing-state";
import {
  receiptRoundKey,
  FAILED_RESULT_WAIT_SECONDS,
  ROUND_INACTIVITY_SECONDS,
  type RoundEvidence,
  type RoundReplyTokenSelection,
} from "./receipt-round";
export { ReceiptRoundCoordinator } from "./receipt-round-coordinator";
export { OperationalCounterCoordinator } from "./operational-counters";
import { d1StateStore, purgeExpiredState } from "./state-store";
import {
  DEFAULT_PADDLEOCR_MODEL,
  MAX_PADDLEOCR_POLLS,
  PADDLEOCR_INLINE_POLLS,
  PADDLEOCR_POLL_DELAY_SECONDS,
  pollPaddleOcr,
  submitPaddleOcr,
} from "./paddle-ocr";
import {
  deferPendingQueueJob,
  isCurrentQueueJobDay,
  listPendingQueueJobs,
  removePendingQueueJob,
  savePendingQueueJobs,
  type PendingQueueItem,
  type PendingQueueTarget,
} from "./pending-queue-jobs";
import {
  fetchCastleServiceSnapshot,
  formatServiceLookMessages,
  loadTechnicianNotifiedServiceJobKeys,
  loadSeenServiceJobKeys,
  saveTechnicianNotifiedServiceJobs,
  saveSeenServiceJobs,
  selectNewServiceJobs,
  selectUnnotifiedServiceJobsForTechnician,
  type CastleServiceJob,
} from "./service-look";
import { listServiceAreaMentions } from "./service-technicians";
import {
  isLineWebhookQueueJob,
  isFailureFinalizeJob,
  isOcrFallbackJob,
  isPaddlePollJob,
  isRoundFinalizeJob,
  type ImageJob,
  type FailureFinalizeJob,
  type LineWebhookQueueJob,
  type LineWebhookEvent,
  type LineWebhookBody,
  type OcrFallbackJob,
  type PaddlePollJob,
  type QueueJob,
  type ReceiptInspection,
  type RoundFinalizeJob,
} from "./types";

type ProcessOutcome = "pass" | "fail" | "ignored";

// LINE reply tokens are documented as short-lived and single-use. Keep a
// safety margin so a token is never intentionally sent at the edge of expiry.
const MAX_REPLY_TOKEN_AGE_MS = 45_000;

function paddleTokenForJob(job: ImageJob, env: Env): { token: string; slot: 1 | 2 } | null {
  const primary = env.PADDLEOCR_TOKEN?.trim();
  const secondary = env.PADDLEOCR_TOKEN_2?.trim();
  if (!primary && !secondary) return null;
  if (!secondary) return primary ? { token: primary, slot: 1 } : null;
  const key = `${job.imageSetId ?? job.messageId}:${job.imageSetIndex ?? 0}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % 2 === 0
    ? { token: primary ?? secondary, slot: primary ? 1 : 2 }
    : { token: secondary, slot: 2 };
}

function assertFreshReplyToken(
  job: ImageJob,
  selected: RoundReplyTokenSelection | null,
): void {
  const receivedAtMs = selected?.receivedAtMs ?? job.replyTokenReceivedAtMs ?? job.timestamp;
  if (typeof receivedAtMs !== "number" || !Number.isFinite(receivedAtMs)) return;
  const ageMs = Math.max(0, Date.now() - receivedAtMs);
  if (ageMs < MAX_REPLY_TOKEN_AGE_MS) return;
  console.warn(JSON.stringify({
    event: "reply_token_expired_before_delivery",
    messageId: job.messageId,
    sourceMessageId: selected?.messageId ?? job.messageId,
    referenceCode: job.referenceCode,
    ageMs,
  }));
  throw new Error(`LINE reply token too old for delivery (${ageMs}ms)`);
}
interface ProcessResult {
  outcome: ProcessOutcome;
  evidence?: Omit<RoundEvidence, "job">;
}

const IGNORED_RESULT: ProcessResult = { outcome: "ignored" };

interface ProcessImageOptions {
  skipOcrSpace?: boolean;
  downloadedImage?: Uint8Array;
  paddleInspection?: ReceiptInspection;
}

interface PreparedTechnicianServiceAlert {
  lineUserId: string;
  previousNotified: Set<string>;
  displayedJobs: CastleServiceJob[];
  messages: Record<string, unknown>[];
}

async function prepareTechnicianServiceAlert(
  job: ImageJob,
  env: Env,
): Promise<PreparedTechnicianServiceAlert | null> {
  const lineUserId = job.senderUserId;
  if (!lineUserId) return null;
  try {
    const areaMentions = (await listServiceAreaMentions(env.CONTROL_DB, true))
      .filter((mention) => mention.lineUserId === lineUserId);
    if (areaMentions.length === 0) return null;

    const store = d1StateStore(env.CONTROL_DB);
    const [snapshot, previousNotified] = await Promise.all([
      fetchCastleServiceSnapshot(env.CASTLE_SERVICE),
      loadTechnicianNotifiedServiceJobKeys(store, lineUserId),
    ]);
    const newJobs = selectUnnotifiedServiceJobsForTechnician(
      snapshot,
      areaMentions,
      lineUserId,
      previousNotified,
    );
    if (newJobs.length === 0) return null;

    const result = formatServiceLookMessages(
      snapshot,
      newJobs,
      "new",
      areaMentions,
      3,
    );
    return {
      lineUserId,
      previousNotified,
      displayedJobs: result.displayedJobs,
      messages: result.messages,
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: "technician_service_alert_prepare_failed",
      webhookEventId: job.webhookEventId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
    return null;
  }
}

async function recordTechnicianServiceAlert(
  alert: PreparedTechnicianServiceAlert | null,
  env: Env,
  webhookEventId: string,
): Promise<void> {
  if (!alert) return;
  try {
    await saveTechnicianNotifiedServiceJobs(
      d1StateStore(env.CONTROL_DB),
      alert.lineUserId,
      alert.previousNotified,
      alert.displayedJobs,
    );
    console.log(JSON.stringify({
      event: "technician_service_alert_replied",
      webhookEventId,
      lineUserId: alert.lineUserId,
      jobs: alert.displayedJobs.length,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "technician_service_alert_state_save_failed",
      webhookEventId,
      lineUserId: alert.lineUserId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function handleServiceLookCommand(
  context: ServiceLookContext,
  env: Env,
): Promise<void> {
  const conversationId = context.replyTarget;
  if (!conversationId) {
    console.warn(JSON.stringify({
      event: "service_look_ignored",
      webhookEventId: context.webhookEventId,
      reason: "missing-conversation-id",
    }));
    return;
  }

  const store = d1StateStore(env.CONTROL_DB);
  let snapshot: Awaited<ReturnType<typeof fetchCastleServiceSnapshot>>;
  let seen: Awaited<ReturnType<typeof loadSeenServiceJobKeys>> | null = null;
  let result: ReturnType<typeof formatServiceLookMessages>;
  try {
    snapshot = await fetchCastleServiceSnapshot(env.CASTLE_SERVICE);
    if (context.serviceLookMode === "all") {
      result = formatServiceLookMessages(
        snapshot,
        snapshot.jobs,
        "all",
      );
    } else {
      seen = await loadSeenServiceJobKeys(store, conversationId);
      result = formatServiceLookMessages(
        snapshot,
        selectNewServiceJobs(snapshot, seen),
        "new",
      );
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "service_look_read_failed",
      webhookEventId: context.webhookEventId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
    await sendReplyMessages(
      context,
      [{
        type: "text",
        text: "ไม่สามารถอ่านรายการงาน Service ได้ กรุณาลองใหม่อีกครั้ง",
      }],
      env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    return;
  }

  const sent = await sendReplyMessages(
    context,
    result.messages,
    env.LINE_CHANNEL_ACCESS_TOKEN,
  );
  if (!sent) {
    console.error(JSON.stringify({
      event: "service_look_reply_failed",
      webhookEventId: context.webhookEventId,
    }));
    return;
  }

  if (context.serviceLookMode === "all" || !seen) {
    console.log(JSON.stringify({
      event: "service_look_all_replied",
      webhookEventId: context.webhookEventId,
      activeJobs: snapshot.totalJobs,
      displayedJobs: result.displayedJobs.length,
      messageCount: result.messages.length,
    }));
    return;
  }

  try {
    await saveSeenServiceJobs(
      store,
      conversationId,
      snapshot,
      seen,
      result.displayedJobs,
    );
    console.log(JSON.stringify({
      event: "service_look_replied",
      webhookEventId: context.webhookEventId,
      activeJobs: snapshot.totalJobs,
      newJobs: result.displayedJobs.length,
      messageCount: result.messages.length,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "service_look_state_save_failed",
      webhookEventId: context.webhookEventId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function timedProvider<T>(
  trace: InspectionTrace,
  provider: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  trace.providers.push(provider);
  try {
    return await operation();
  } finally {
    trace.providerTimings[provider] =
      (trace.providerTimings[provider] ?? 0) + Date.now() - startedAt;
  }
}

function updateTraceFromInspection(
  trace: InspectionTrace,
  inspection: { isKplusReceipt: boolean; hasSettlement: boolean; observedAmounts: number[] },
  stage: string,
): void {
  trace.stage = stage;
  trace.hasKplus = Boolean(trace.hasKplus || inspection.isKplusReceipt);
  trace.hasSettlement = inspection.hasSettlement;
  trace.observedAmounts = inspection.observedAmounts;
  const providerKey = stage.startsWith("paddleocr")
    ? "paddleocr"
    : stage === "ocr-space"
      ? "ocr-space"
      : stage.startsWith("workers-ai")
        ? "workers-ai"
        : stage === "google-vision"
          ? "google-vision"
          : stage;
  trace.providerFindings ??= {};
  trace.providerFindings[providerKey] = {
    kplus: inspection.isKplusReceipt,
    settlement: inspection.hasSettlement,
    amounts: inspection.observedAmounts.slice(0, 8),
  };
}

async function recordStat(env: Env, name: DailyStatName): Promise<void> {
  try {
    await incrementDailyStat(env.OPERATIONAL_COUNTERS, name);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "daily_stat_record_failed",
      stat: name,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function recordAuditSafely(
  env: Env,
  job: ImageJob,
  outcome: "pass" | "fail" | "ignored" | "error",
  trace: InspectionTrace,
  startedAt: number,
  error?: string,
): Promise<void> {
  try {
    await recordInspectionLog(env.CONTROL_DB, job, outcome, trace, startedAt, error);
  } catch (auditError) {
    console.error(JSON.stringify({
      event: "inspection_log_failed",
      messageId: job.messageId,
      error: auditError instanceof Error ? auditError.message : "unknown error",
    }));
  }
}

function numericSetting(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name} setting`);
  return parsed;
}

function queueErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function sendQueueBodies(
  target: PendingQueueTarget,
  bodies: QueueJob[],
  env: Env,
): Promise<void> {
  if (bodies.length === 0) return;
  if (target === "images") {
    await env.IMAGE_QUEUE.sendBatch(
      bodies.map((body) => ({
        body: body as ImageJob | RoundFinalizeJob | FailureFinalizeJob | PaddlePollJob,
      })),
    );
    await recordQueueStatSafely(env, "queueWrites", bodies.length);
    return;
  }
  if (target === "ocr-fallback") {
    await env.OCR_FALLBACK_QUEUE.sendBatch(
      bodies.map((body) => ({ body: body as OcrFallbackJob })),
    );
    await recordQueueStatSafely(env, "queueWrites", bodies.length);
    return;
  }
  await env.LINE_WEBHOOKS.sendBatch(
    bodies.map((body) => ({ body: body as LineWebhookQueueJob })),
  );
  await recordQueueStatSafely(env, "queueWrites", bodies.length);
}

async function enqueueQueueBodiesSafely(
  target: PendingQueueTarget,
  bodies: QueueJob[],
  env: Env,
): Promise<"queued" | "deferred"> {
  try {
    await sendQueueBodies(target, bodies, env);
    return "queued";
  } catch (error) {
    const detail = queueErrorText(error);
    try {
      const stored = await savePendingQueueJobs(
        env.CONTROL_DB,
        target,
        bodies,
        detail,
      );
      console.error(JSON.stringify({
        event: "queue_write_deferred",
        target,
        count: bodies.length,
        stored,
        error: detail,
      }));
      return "deferred";
    } catch (persistError) {
      console.error(JSON.stringify({
        event: "queue_write_deferred_persist_failed",
        target,
        count: bodies.length,
        error: detail,
        persistError: queueErrorText(persistError),
      }));
      throw persistError;
    }
  }
}

type QueueDailyStatName = "queueWrites" | "queueReads" | "queueDeletes";

async function recordQueueStatSafely(
  env: Env,
  name: QueueDailyStatName,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  try {
    await incrementDailyStatBy(env.OPERATIONAL_COUNTERS, name, amount);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "queue_stat_record_failed",
      stat: name,
      amount,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function enqueueImageJobs(
  jobs: ImageJob[],
  env: Env,
): Promise<{ queued: number; deferred: number }> {
  let queued = 0;
  let deferred = 0;
  for (let index = 0; index < jobs.length; index += 100) {
    const chunk = jobs.slice(index, index + 100);
    const result = await enqueueQueueBodiesSafely("images", chunk, env);
    if (result === "queued") queued += chunk.length;
    else deferred += chunk.length;
  }
  return { queued, deferred };
}

async function drainPendingQueueJobs(env: Env): Promise<{
  sent: number;
  deferred: number;
}> {
  const items = await listPendingQueueJobs(env.CONTROL_DB, Date.now(), 100);
  if (items.length === 0) return { sent: 0, deferred: 0 };

  const groups = new Map<PendingQueueTarget, PendingQueueItem[]>();
  for (const item of items) {
    const group = groups.get(item.target) ?? [];
    group.push(item);
    groups.set(item.target, group);
  }

  let sent = 0;
  let deferred = 0;
  for (const [target, group] of groups) {
    for (let index = 0; index < group.length; index += 100) {
      const chunk = group.slice(index, index + 100);
      try {
        await sendQueueBodies(target, chunk.map((item) => item.body), env);
        await Promise.all(
          chunk.map((item) => removePendingQueueJob(env.CONTROL_DB, item.key)),
        );
        sent += chunk.length;
      } catch (error) {
        await Promise.all(
          chunk.map((item) =>
            deferPendingQueueJob(env.CONTROL_DB, item, error),
          ),
        );
        deferred += chunk.length;
        console.error(JSON.stringify({
          event: "pending_queue_drain_deferred",
          target,
          count: chunk.length,
          error: queueErrorText(error),
        }));
      }
    }
  }
  return { sent, deferred };
}

async function claimStockFlex(job: ImageJob, env: Env): Promise<boolean> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return true;
  return (await env.RECEIPT_ROUNDS.getByName(roundKey).claimStock(job)) ===
    "acquired";
}

async function releaseStockFlex(job: ImageJob, env: Env): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  await env.RECEIPT_ROUNDS.getByName(roundKey).releaseStock(job);
}

async function completeStockFlex(job: ImageJob, env: Env): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  await env.RECEIPT_ROUNDS.getByName(roundKey).completeStock(job);
}

async function recordReplyToken(job: ImageJob, env: Env): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  try {
    await env.RECEIPT_ROUNDS.getByName(roundKey).recordReplyToken(job);
  } catch (error) {
    console.error(JSON.stringify({
      event: "reply_token_record_failed",
      messageId: job.messageId,
      referenceCode: job.referenceCode,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function recordReplyTokens(jobs: ImageJob[], env: Env): Promise<void> {
  for (const job of jobs) await recordReplyToken(job, env);
}

async function selectReplyToken(
  job: ImageJob,
  env: Env,
): Promise<RoundReplyTokenSelection | null> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return null;
  try {
    const now = Date.now();
    const ownReceivedAtMs = job.replyTokenReceivedAtMs;
    const ownToken = typeof ownReceivedAtMs === "number" &&
        Number.isFinite(ownReceivedAtMs) &&
        now - ownReceivedAtMs < MAX_REPLY_TOKEN_AGE_MS
      ? {
          messageId: job.messageId,
          replyToken: job.replyToken,
          receivedAtMs: ownReceivedAtMs,
        }
      : null;
    const stored = await env.RECEIPT_ROUNDS.getByName(roundKey).selectReplyToken(job);
    const storedFresh = stored && now - stored.receivedAtMs < MAX_REPLY_TOKEN_AGE_MS
      ? stored
      : null;
    const selected = ownToken && (!storedFresh || ownToken.receivedAtMs >= storedFresh.receivedAtMs)
      ? ownToken
      : storedFresh;
    if (!selected) return null;
    const ageMs = Math.max(0, now - selected.receivedAtMs);
    console.log(JSON.stringify({
      event: "reply_token_selected",
      messageId: job.messageId,
      sourceMessageId: selected.messageId,
      referenceCode: job.referenceCode,
      ageMs,
      source: selected.messageId === job.messageId ? "current-job" : "round-latest",
    }));
    return selected;
  } catch (error) {
    console.error(JSON.stringify({
      event: "reply_token_select_failed",
      messageId: job.messageId,
      referenceCode: job.referenceCode,
      error: error instanceof Error ? error.message : "unknown error",
    }));
    return null;
  }
}

async function markReplyTokenUsed(
  job: ImageJob,
  sourceMessageId: string | undefined,
  env: Env,
): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey || !sourceMessageId) return;
  try {
    await env.RECEIPT_ROUNDS.getByName(roundKey).completeReplyToken(job, sourceMessageId);
  } catch (error) {
    console.error(JSON.stringify({
      event: "reply_token_mark_used_failed",
      messageId: job.messageId,
      sourceMessageId,
      referenceCode: job.referenceCode,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

async function replyStockFlexOnce(
  job: ImageJob,
  env: Env,
  trace: InspectionTrace,
): Promise<"sent" | "suppressed"> {
  const includeStock = await claimStockFlex(job, env);
  if (!includeStock) return "suppressed";

  trace.lineDeliveryStatus = "pending";
  const selectedReply = await selectReplyToken(job, env);
  const replyJob = selectedReply
    ? { ...job, replyToken: selectedReply.replyToken }
    : job;
  try {
    assertFreshReplyToken(job, selectedReply);
    const sent = await sendReplyMessages(
      replyJob,
      [stockFlexMessage(job.referenceCode)],
      env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!sent) throw new Error("LINE Stock Flex reply failed");
    await markReplyTokenUsed(job, selectedReply?.messageId, env);
    await completeStockFlex(job, env);
    trace.lineDeliveryStatus = "sent";
    trace.lineDeliveryMethod = "reply";
    return "sent";
  } catch (error) {
    trace.lineDeliveryStatus = "failed";
    delete trace.lineDeliveryMethod;
    await releaseStockFlex(job, env);
    throw error;
  }
}

async function updateAuditLineDeliverySafely(
  env: Env,
  job: ImageJob,
  status: "sent" | "failed",
): Promise<void> {
  try {
    await updateLineDeliveryStatus(
      env.CONTROL_DB,
      job.messageId,
      status,
      status === "sent" ? "reply" : null,
    );
  } catch (auditError) {
    console.error(JSON.stringify({
      event: "inspection_delivery_log_update_failed",
      messageId: job.messageId,
      error: auditError instanceof Error ? auditError.message : "unknown error",
    }));
  }
}

async function replyKplusSuccess(
  job: ImageJob,
  amount: number,
  provider: string,
  env: Env,
  trace: InspectionTrace,
): Promise<ProcessResult> {
  const roundKey = receiptRoundKey(job);
  if (roundKey) {
    const claim = await env.RECEIPT_ROUNDS.getByName(roundKey).claimPass(job);
    if (claim === "suppressed") return IGNORED_RESULT;
    if (claim === "busy") throw new Error("Pass delivery is already in progress");
  }

  trace.lineDeliveryStatus = "pending";
  let method: LineDeliveryMethod | null = null;
  const includeStock = await claimStockFlex(job, env);
  const serviceAlert = await prepareTechnicianServiceAlert(job, env);
  const selectedReply = await selectReplyToken(job, env);
  const replyJob = selectedReply
    ? { ...job, replyToken: selectedReply.replyToken }
    : job;
  try {
    assertFreshReplyToken(job, selectedReply);
    method = await sendInspectionResultWithMethod(
      replyJob,
      formatKplusSuccess(amount),
      env.LINE_CHANNEL_ACCESS_TOKEN,
      serviceAlert?.messages ?? [],
      includeStock,
    );
    if (!method) throw new Error("LINE inspection result delivery failed");
    await markReplyTokenUsed(job, selectedReply?.messageId, env);
    trace.lineDeliveryStatus = "sent";
    trace.lineDeliveryMethod = method;
  } catch (error) {
    trace.lineDeliveryStatus = "failed";
    delete trace.lineDeliveryMethod;
    if (roundKey) {
      await env.RECEIPT_ROUNDS.getByName(roundKey).releasePass(job);
    }
    if (includeStock) await releaseStockFlex(job, env);
    throw error;
  }
  if (includeStock) await completeStockFlex(job, env);
  await recordTechnicianServiceAlert(serviceAlert, env, job.webhookEventId);
  if (roundKey) {
    try {
      await env.RECEIPT_ROUNDS.getByName(roundKey).completeAfterPass(job);
    } catch (error) {
      console.error(JSON.stringify({
        event: "pass_completion_record_failed",
        messageId: job.messageId,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }
  try {
    await recordRecentPass(job, d1StateStore(env.CONTROL_DB));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "recent_pass_record_failed",
      messageId: job.messageId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }

  console.log(JSON.stringify({
    event: "kplus_receipt_passed",
    webhookEventId: job.webhookEventId,
    provider,
    imageSetId: job.imageSetId,
    imageSetTotal: job.imageSetTotal,
    amount,
  }));
  return { outcome: "pass" };
}

async function replyKplusFailure(
  job: ImageJob,
  text: string,
  env: Env,
  trace: InspectionTrace,
): Promise<"sent" | "suppressed"> {
  const roundKey = receiptRoundKey(job);
  if (roundKey) {
    const claim = await env.RECEIPT_ROUNDS.getByName(roundKey).claimFailure(job);
    if (claim === "suppressed") return "suppressed";
    if (claim === "busy") throw new Error("Failure delivery is already in progress");
  }

  trace.lineDeliveryStatus = "pending";
  const includeStock = await claimStockFlex(job, env);
  const serviceAlert = await prepareTechnicianServiceAlert(job, env);
  const selectedReply = await selectReplyToken(job, env);
  const replyJob = selectedReply
    ? { ...job, replyToken: selectedReply.replyToken }
    : job;
  try {
    assertFreshReplyToken(job, selectedReply);
    const method = await sendInspectionResultWithMethod(
      replyJob,
      text,
      env.LINE_CHANNEL_ACCESS_TOKEN,
      serviceAlert?.messages ?? [],
      includeStock,
    );
    if (method !== "reply") throw new Error("LINE inspection reply failed");
    await markReplyTokenUsed(job, selectedReply?.messageId, env);
    trace.lineDeliveryStatus = "sent";
    trace.lineDeliveryMethod = "reply";
  } catch (error) {
    trace.lineDeliveryStatus = "failed";
    delete trace.lineDeliveryMethod;
    if (roundKey) {
      await env.RECEIPT_ROUNDS.getByName(roundKey).releaseFailure(job);
    }
    if (includeStock) await releaseStockFlex(job, env);
    throw error;
  }
  if (includeStock) await completeStockFlex(job, env);

  await recordTechnicianServiceAlert(serviceAlert, env, job.webhookEventId);

  if (roundKey) {
    try {
      await env.RECEIPT_ROUNDS.getByName(roundKey).completeAfterFailure(job);
    } catch (error) {
      console.error(JSON.stringify({
        event: "failure_completion_record_failed",
        messageId: job.messageId,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }
  return "sent";
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-line-signature");
  if (!signature) return new Response("Missing signature", { status: 401 });

  const body = await request.arrayBuffer();
  const receivedAtMs = Date.now();
  if (!(await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as LineWebhookBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log(JSON.stringify({
    event: "line_webhook_received",
    eventCount: payload.events?.length ?? 0,
    imageEvents: (payload.events ?? [])
      .filter((event) => event.type === "message" && event.message?.type === "image")
      .map((event) => ({
        messageId: event.message?.id,
        imageSetId: event.message?.imageSet?.id,
        imageSetIndex: event.message?.imageSet?.index,
        imageSetTotal: event.message?.imageSet?.total,
      })),
  }));

  const operationalState = d1StateStore(env.CONTROL_DB);
  const imageJobs: ImageJob[] = [];
  for (const event of payload.events ?? []) {
    const serviceLookContext = serviceLookContextFromEvent(event);
    if (serviceLookContext) {
      await handleServiceLookCommand(serviceLookContext, env);
      continue;
    }

    const scope = conversationAndSenderFromEvent(event);
    const referenceCode = referenceCodeFromEvent(event);
    if (scope && referenceCode) {
      await storeJobReference(
        scope.conversationId,
        scope.senderId,
        referenceCode,
        operationalState,
        event.timestamp,
      );
      console.log(JSON.stringify({
        event: "job_reference_recorded",
        referenceCode,
        sourceType: event.source?.type,
        timestamp: event.timestamp,
      }));
      continue;
    }

    const imageJob = imageJobFromEvent(event, receivedAtMs);
    if (imageJob) {
      const scope = conversationAndSenderFromEvent(event);
      if (scope) {
        const boundReference = imageJob.imageSetId
          ? await getImageSetReference(
            env.CONTROL_DB,
            scope.conversationId,
            scope.senderId,
            imageJob.imageSetId,
          )
          : undefined;
        const referenceCode = boundReference ?? await getJobReference(
          scope.conversationId,
          scope.senderId,
          operationalState,
          imageJob.timestamp,
        );
        imageJob.referenceCode = imageJob.imageSetId && referenceCode && !boundReference
          ? await bindImageSetReference(
            env.CONTROL_DB,
            scope.conversationId,
            scope.senderId,
            imageJob.imageSetId,
            referenceCode,
          )
          : referenceCode;
        if (imageJob.imageSetId && imageJob.referenceCode) {
          console.log(JSON.stringify({
            event: "image_set_tid_bound",
            imageSetId: imageJob.imageSetId,
            messageId: imageJob.messageId,
            referenceCode: imageJob.referenceCode,
          }));
        }
      }
      console.log(JSON.stringify({
        event: "image_job_reference_bound",
        messageId: imageJob.messageId,
        referenceCode: imageJob.referenceCode,
        timestamp: imageJob.timestamp,
      }));
      imageJobs.push(imageJob);
    }
  }

  if (imageJobs.length > 0) {
    if (!(await isProcessingEnabled(
      env.CONTROL_DB,
      String(env.PROCESSING_FORCE_DISABLED) === "true",
    ))) {
      console.log(JSON.stringify({
        event: "webhook_images_skipped",
        reason: "processing-disabled",
        imageCount: imageJobs.length,
      }));
      return Response.json({ accepted: imageJobs.length, queued: 0, deferred: 0 });
    }
    const queueState = operationalState;
    const queueJobs: ImageJob[] = [];
    for (const job of imageJobs) {
      if (await claimImageQueue(job, queueState)) queueJobs.push(job);
    }
    const deduplicated = imageJobs.length - queueJobs.length;
    // Save all Reply tokens before queueing so a delayed image cannot make us
    // fall back to an older token from the same Tid.
    await recordReplyTokens(queueJobs, env);
    let enqueueResult: {
      queued: number;
      deferred: number;
    };
    try {
      enqueueResult = await enqueueImageJobs(queueJobs, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "image_queue_enqueue_failed",
        imageCount: queueJobs.length,
        error: queueErrorText(error),
      }));
      await Promise.all(queueJobs.map((job) => releaseImageQueueClaim(job, queueState)));
      return Response.json({
        accepted: 0,
        queued: 0,
        deferred: 0,
        error: "deferred-storage-failed",
      }, { status: 503 });
    }
    console.log(JSON.stringify({
      event: "image_jobs_enqueued",
      route: "direct-image-queue",
      imageCount: imageJobs.length,
      queued: enqueueResult.queued,
      deferred: enqueueResult.deferred,
      imageSets: imageJobs.map((job) => ({
        messageId: job.messageId,
        imageSetId: job.imageSetId,
        imageSetIndex: job.imageSetIndex,
        imageSetTotal: job.imageSetTotal,
      })),
    }));
    return Response.json({
      accepted: imageJobs.length,
      queued: enqueueResult.queued,
      deferred: enqueueResult.deferred,
      deduplicated,
    });
  }

  return Response.json({ accepted: 0, queued: 0, deferred: 0 });
}

async function processQueuedWebhookEvents(
  events: LineWebhookEvent[],
  env: Env,
  receivedAtMs = Date.now(),
): Promise<void> {
  console.log(JSON.stringify({
    event: "line_webhook_queue_received",
    eventCount: events.length,
    imageEvents: events
      .filter((event) => event.type === "message" && event.message?.type === "image")
      .map((event) => ({
        messageId: event.message?.id,
        imageSetId: event.message?.imageSet?.id,
        imageSetIndex: event.message?.imageSet?.index,
        imageSetTotal: event.message?.imageSet?.total,
      })),
  }));
  if (!(await isProcessingEnabled(
    env.CONTROL_DB,
    String(env.PROCESSING_FORCE_DISABLED) === "true",
  ))) {
    console.log(JSON.stringify({
      event: "webhook_images_skipped",
      reason: "processing-disabled",
      imageCount: events.length,
    }));
    return;
  }

  const operationalState = d1StateStore(env.CONTROL_DB);
  const jobs: ImageJob[] = [];
  for (const event of events) {
    const job = imageJobFromEvent(event, receivedAtMs);
    if (!job) continue;
    const scope = conversationAndSenderFromEvent(event);
    if (scope) {
      const boundReference = job.imageSetId
        ? await getImageSetReference(
          env.CONTROL_DB,
          scope.conversationId,
          scope.senderId,
          job.imageSetId,
        )
        : undefined;
      const referenceCode = boundReference ?? await getJobReference(
        scope.conversationId,
        scope.senderId,
        operationalState,
        job.timestamp,
      );
      job.referenceCode = job.imageSetId && referenceCode && !boundReference
        ? await bindImageSetReference(
          env.CONTROL_DB,
          scope.conversationId,
          scope.senderId,
          job.imageSetId,
          referenceCode,
        )
        : referenceCode;
    }
    jobs.push(job);
  }
  if (jobs.length > 0) {
    const queueState = operationalState;
    const queueJobs: ImageJob[] = [];
    for (const job of jobs) {
      if (await claimImageQueue(job, queueState)) queueJobs.push(job);
    }
    await recordReplyTokens(queueJobs, env);
    const enqueueResult = await enqueueImageJobs(queueJobs, env);
    console.log(JSON.stringify({
      event: "image_jobs_enqueued",
      route: "line-webhook-queue",
      imageCount: jobs.length,
      queued: enqueueResult.queued,
      deferred: enqueueResult.deferred,
      imageSets: jobs.map((job) => ({
        messageId: job.messageId,
        imageSetId: job.imageSetId,
        imageSetIndex: job.imageSetIndex,
        imageSetTotal: job.imageSetTotal,
      })),
    }));
  }
}

async function processImageJob(
  job: ImageJob,
  env: Env,
  trace: InspectionTrace,
  options: ProcessImageOptions = {},
): Promise<ProcessResult> {
  const {
    skipOcrSpace = false,
    downloadedImage,
    paddleInspection,
  } = options;
  const expectedSale = numericSetting(env.EXPECTED_SALE_AMOUNT, "EXPECTED_SALE_AMOUNT");
  const expectedVoid = numericSetting(env.EXPECTED_VOID_AMOUNT, "EXPECTED_VOID_AMOUNT");
  const minConfidence = numericSetting(env.MIN_CONFIDENCE, "MIN_CONFIDENCE");
  let hasKnownKplusEvidence = paddleInspection?.isKplusReceipt ?? false;

  if (await hasRecentPass(job, d1StateStore(env.CONTROL_DB))) {
    trace.stage = "recent-pass-suppression";
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "recent-pass-suppression",
    }));
    return IGNORED_RESULT;
  }

  const original = downloadedImage ??
    await downloadLineImage(job.messageId, env.LINE_CHANNEL_ACCESS_TOKEN);

  if (!skipOcrSpace) {
  const ocrSpaceReservation = env.OCR_SPACE_API_KEY
    ? await reserveOcrSpaceRequest(env.OPERATIONAL_COUNTERS)
    : null;
  if (env.OCR_SPACE_API_KEY && ocrSpaceReservation?.accepted) {
    let ocrSpaceUsage = ocrSpaceReservation.value;
    let ocrSpaceResult: Awaited<ReturnType<typeof ocrSpaceOcr>> | null = null;
    try {
      await recordStat(env, "ocrSpaceCalls");
      ocrSpaceResult = await timedProvider(
        trace,
        "ocr-space",
        () => ocrSpaceOcr(original, env.OCR_SPACE_API_KEY!),
      );
    } catch (error) {
      await recordStat(env, "ocrSpaceErrors");
      console.warn(JSON.stringify({
        event: "ocr_space_fallback",
        webhookEventId: job.webhookEventId,
        reason: "request-failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }

    if (ocrSpaceResult) {
      if (ocrSpaceResult.status === "quota-exhausted") {
        await recordStat(env, "ocrSpaceErrors");
        try {
          await markOcrSpaceQuotaExhausted(env.OPERATIONAL_COUNTERS);
        } catch (error) {
          console.warn(JSON.stringify({
            event: "ocr_space_quota_marker_failed",
            webhookEventId: job.webhookEventId,
            error: error instanceof Error ? error.message : "unknown error",
          }));
        }
        ocrSpaceUsage = 500;
        console.log(JSON.stringify({
          event: "ocr_space_fallback",
          webhookEventId: job.webhookEventId,
          reason: "provider-quota-exhausted",
          ocrSpaceUsage,
        }));
      } else if (ocrSpaceResult.status === "error") {
        await recordStat(env, "ocrSpaceErrors");
        console.log(JSON.stringify({
          event: "ocr_space_fallback",
          webhookEventId: job.webhookEventId,
          reason: "provider-error",
          error: ocrSpaceResult.error,
          ocrSpaceUsage,
        }));
      } else {
        const ocrSpaceRawInspection = inspectConfirmedReceiptText(ocrSpaceResult.text);
        const ocrSpaceInspection = acceptWorkerPaymentName(
          ocrSpaceRawInspection,
          ocrSpaceResult.text,
        );
        const ocrSpaceDecision = decideReceipt(
          ocrSpaceInspection,
          expectedSale,
          expectedVoid,
          minConfidence,
        );
        const ocrSpaceRoute = routeOcrSpaceDecision(
          ocrSpaceDecision,
          ocrSpaceInspection,
          hasKnownKplusEvidence,
        );
        hasKnownKplusEvidence ||= ocrSpaceInspection.isKplusReceipt;
        updateTraceFromInspection(trace, ocrSpaceInspection, "ocr-space");
        if (paddleInspection) {
          const combinedEvidence = combineReceiptEvidence(
            paddleInspection,
            ocrSpaceInspection,
            expectedSale,
            expectedVoid,
            minConfidence,
          );
          if (combinedEvidence.decision.status === "pass") {
            trace.stage = "paddle-ocrspace-combined";
            const matchedAmount = combinedEvidence.inspection.observedAmounts.find(
              (amount) =>
                Math.abs(amount - expectedSale) < 0.005 ||
                Math.abs(amount - expectedVoid) < 0.005,
            ) ?? expectedSale;
            console.log(JSON.stringify({
              event: "ocr_positive_evidence_combined",
              webhookEventId: job.webhookEventId,
              providers: ["paddleocr", "ocr-space"],
              matchedAmount,
              ocrSpaceUsage,
            }));
            return replyKplusSuccess(
              job,
              matchedAmount,
              "paddleocr+ocr-space",
              env,
              trace,
            );
          }
        }
        if (ocrSpaceRoute === "pass") {
          const matchedAmount = ocrSpaceInspection.observedAmounts.find(
            (amount) =>
              Math.abs(amount - expectedSale) < 0.005 ||
              Math.abs(amount - expectedVoid) < 0.005,
          ) ?? expectedSale;
          return replyKplusSuccess(
            job,
            matchedAmount,
            "ocr-space",
            env,
            trace,
          );
        }

        if (
          ocrSpaceRoute === "fallback" &&
          paddleInspection &&
          hasWrongAmountConsensus(
            paddleInspection,
            ocrSpaceInspection,
            expectedSale,
            expectedVoid,
          )
        ) {
          trace.stage = "paddle-ocrspace-consensus";
          console.log(JSON.stringify({
            event: "ocr_wrong_amount_consensus",
            webhookEventId: job.webhookEventId,
            providers: ["paddleocr", "ocr-space"],
            paddleAmounts: paddleInspection.observedAmounts,
            ocrSpaceAmounts: ocrSpaceInspection.observedAmounts,
            ocrSpaceUsage,
          }));
          return {
            outcome: "fail",
            evidence: {
              kind: "wrong-amount",
              text: formatDecision(ocrSpaceInspection, ocrSpaceDecision),
            },
          };
        }

        if (ocrSpaceRoute === "ignore") {
          trace.stage = "ocr-space-filter";
          console.log(JSON.stringify({
            event: "image_ignored",
            webhookEventId: job.webhookEventId,
            stage: "ocr-space-filter",
            ocrSpaceUsage,
          }));
          return IGNORED_RESULT;
        }

        console.log(JSON.stringify({
          event: "ocr_space_fallback",
          webhookEventId: job.webhookEventId,
          reason: ocrSpaceInspection.isKplusReceipt && ocrSpaceInspection.hasSettlement
            ? "expected-amount-not-found"
            : "known-kplus-requires-detailed-check",
          hasKnownKplusEvidence,
          ocrSpaceUsage,
        }));
      }
    }
  } else {
    console.log(JSON.stringify({
      event: "ocr_space_skipped",
      webhookEventId: job.webhookEventId,
      reason: env.OCR_SPACE_API_KEY ? "daily-limit" : "api-key-missing",
    }));
  }
  }

  let workerText: string;
  try {
    await recordStat(env, "workersAiCalls");
    workerText = await timedProvider(
      trace,
      "workers-ai",
      () => transcribeVisibleText(env.AI, original),
    );
  } catch (error) {
    await recordStat(env, "workersAiErrors");
    throw error;
  }
  const workerInspection = inspectReceiptText(workerText);
  const workerHasExpectedAmount = hasExpectedAmount(
    workerInspection,
    expectedSale,
    expectedVoid,
  );
  const workerHasAnyAmount = workerInspection.observedAmounts.length > 0;
  const workerMatchedThaiQr = hasThaiQrPaymentText(workerText);
  const acceptedWorkerInspection = acceptWorkerPaymentName(
    workerInspection,
    workerText,
  );
  const workerDecision = decideReceipt(
    acceptedWorkerInspection,
    expectedSale,
    expectedVoid,
    minConfidence,
  );
  hasKnownKplusEvidence ||= acceptedWorkerInspection.isKplusReceipt;
  updateTraceFromInspection(trace, acceptedWorkerInspection, "workers-ai");

  if (workerDecision.status === "pass") {
    const matchedAmount = acceptedWorkerInspection.observedAmounts.find(
      (amount) =>
        Math.abs(amount - expectedSale) < 0.005 ||
        Math.abs(amount - expectedVoid) < 0.005,
    ) ?? expectedSale;
    return replyKplusSuccess(
      job,
      matchedAmount,
      "workers-ai",
      env,
      trace,
    );
  }

  const hasPartialTextEvidence = hasGoogleCandidateTextEvidence(
    workerInspection,
    expectedSale,
    expectedVoid,
    workerText,
  );
  const visualClassifierAttempted = !hasPartialTextEvidence;
  let visualKplusCandidate = false;
  if (visualClassifierAttempted) {
    try {
      await recordStat(env, "workersAiCalls");
      visualKplusCandidate = await timedProvider(
        trace,
        "workers-ai-visual",
        () => classifyKplusVisualCandidate(env.AI, original),
      );
    } catch (error) {
      await recordStat(env, "workersAiErrors");
      throw error;
    }
  }
  const googleCandidate = shouldContinueToGoogleVision(
    hasKnownKplusEvidence,
    hasPartialTextEvidence,
    visualKplusCandidate,
  );

  if (!googleCandidate) {
    trace.stage = "workers-ai-filter";
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "workers-ai-filter",
      workerMatchedKplus: workerInspection.isKplusReceipt,
      workerHasExpectedAmount,
      workerHasSettlement: workerInspection.hasSettlement,
      workerHasAnyAmount,
      workerMatchedThaiQr,
      hasKnownKplusEvidence,
      visualClassifierAttempted,
      visualKplusCandidate,
    }));
    return IGNORED_RESULT;
  }

  if (!env.GOOGLE_VISION_API_KEY) {
    throw new Error("GOOGLE_VISION_API_KEY is required for fallback inspection");
  }

  const googleVisionReservation = await reserveGoogleVisionRequest(
    env.OPERATIONAL_COUNTERS,
  );
  if (!googleVisionReservation.accepted) {
    await recordStat(env, "googleVisionCapSkips");
    console.warn(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "google-vision-monthly-cap",
    }));
    return IGNORED_RESULT;
  }

  let receiptText: string;
  try {
    await recordStat(env, "googleVisionCalls");
    receiptText = await timedProvider(
      trace,
      "google-vision",
      () => googleVisionOcr(original, env.GOOGLE_VISION_API_KEY!),
    );
  } catch (error) {
    await recordStat(env, "googleVisionErrors");
    throw error;
  }
  const googleVisionUsage = googleVisionReservation.value;
  const inspection = inspectConfirmedReceiptText(receiptText);
  const decision = decideReceipt(
    inspection,
    expectedSale,
    expectedVoid,
    minConfidence,
  );
  updateTraceFromInspection(trace, inspection, "google-vision");

  if (!shouldReplyAfterGoogleVision(inspection)) {
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "google-vision",
      googleMatchedKplus: inspection.isKplusReceipt,
      googleHasSettlement: inspection.hasSettlement,
      googleObservedAmounts: inspection.observedAmounts,
      workerStatus: workerDecision.status,
      workerMatchedKplus: workerInspection.isKplusReceipt,
      workerHasExpectedAmount,
      workerHasSettlement: workerInspection.hasSettlement,
      workerHasAnyAmount,
      workerMatchedThaiQr,
      hasKnownKplusEvidence,
      visualClassifierAttempted,
      visualKplusCandidate,
      googleVisionUsage,
    }));
    return IGNORED_RESULT;
  }

  if (decision.status === "pass") {
    const matchedAmount = inspection.observedAmounts.find(
      (amount) =>
        Math.abs(amount - expectedSale) < 0.005 ||
        Math.abs(amount - expectedVoid) < 0.005,
    ) ?? expectedSale;
    return replyKplusSuccess(
      job,
      matchedAmount,
      "google-vision",
      env,
      trace,
    );
  }

  if (await hasRecentPass(job, d1StateStore(env.CONTROL_DB))) {
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "recent-pass-suppression",
      pendingStatus: decision.status,
      ocrProvider: "google-vision",
    }));
    return IGNORED_RESULT;
  }

  console.log(JSON.stringify({
    event: "receipt_processed",
    webhookEventId: job.webhookEventId,
    status: decision.status,
    confidence: inspection.confidence,
    googleHasSettlement: inspection.hasSettlement,
    ocrProvider: "google-vision",
    workerMatchedKplus: workerInspection.isKplusReceipt,
    workerHasExpectedAmount,
    workerHasSettlement: workerInspection.hasSettlement,
    workerHasAnyAmount,
    workerMatchedThaiQr,
    visualClassifierAttempted,
    visualKplusCandidate,
    googleVisionUsage,
  }));
  return {
    outcome: "fail",
    evidence: {
      kind: inspection.observedAmounts.length > 0 ? "wrong-amount" : "uncertain",
      text: formatDecision(
        inspection,
        inspection.observedAmounts.length > 0
          ? decision
          : { status: "uncertain", failures: ["อ่านยอดเงินไม่ได้"] },
      ),
    },
  };
}

function paddleStateKey(job: ImageJob): string {
  return `paddle-job:${job.webhookEventId}:${job.messageId}`;
}

async function processPaddleFallbackInline(
  job: ImageJob,
  reason: string,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<void> {
  console.warn(JSON.stringify({
    event: "paddleocr_fallback_inline",
    messageId: job.messageId,
    reason,
  }));
  const result = await processImageJob(job, env, trace);
  await finalizeImageResult(job, result, env, trace, startedAt);
}

function waitForPaddlePoll(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PADDLEOCR_POLL_DELAY_SECONDS * 1000);
  });
}

async function finalizePaddleText(
  job: ImageJob,
  text: string,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<void> {
  const result = await processPaddleText(job, text, env, trace);
  await finalizeImageResult(job, result, env, trace, startedAt);
}

async function submitPaddleJob(
  job: ImageJob,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<void> {
  const paddle = paddleTokenForJob(job, env);
  if (!paddle) {
    await processPaddleFallbackInline(
      job,
      "PADDLEOCR_TOKEN is not configured",
      env,
      trace,
      startedAt,
    );
    return;
  }

  const store = d1StateStore(env.CONTROL_DB);
  const key = paddleStateKey(job);
  let jobId = await store.get(key);
  let downstreamStarted = false;
  try {
    if (!jobId) {
      const image = await downloadLineImage(
        job.messageId,
        env.LINE_CHANNEL_ACCESS_TOKEN,
      );
      jobId = await submitPaddleOcr(
        image,
        paddle.token,
        env.PADDLEOCR_MODEL?.trim() || DEFAULT_PADDLEOCR_MODEL,
      );
      await store.put(key, jobId, { expirationTtl: 24 * 60 * 60 });
      console.log(JSON.stringify({
        event: "paddleocr_submitted",
        messageId: job.messageId,
        paddleJobId: jobId,
      }));
    }
    for (let pollCount = 0; pollCount < PADDLEOCR_INLINE_POLLS; pollCount += 1) {
      const status = await timedProvider(
        trace,
        "paddleocr-poll",
        () => pollPaddleOcr(jobId!, paddle.token),
      );
      if (status.state === "done") {
        downstreamStarted = true;
        await finalizePaddleText(job, status.text ?? "", env, trace, startedAt);
        return;
      }
      if (pollCount + 1 < PADDLEOCR_INLINE_POLLS) await waitForPaddlePoll();
    }

    // Reply tokens are short-lived and cannot be replaced with Push API.
    // Continue through the fast fallback chain now instead of waiting for a
    // delayed Paddle poll that would usually outlive the reply-token window.
    downstreamStarted = true;
    await processPaddleFallbackInline(
      job,
      "PaddleOCR remained pending after inline polls; continuing with fallback OCR",
      env,
      trace,
      startedAt,
    );
  } catch (error) {
    if (downstreamStarted) throw error;
    await processPaddleFallbackInline(
      job,
      `PaddleOCR submit/poll failed: ${queueErrorText(error)}`,
      env,
      trace,
      startedAt,
    );
  }
}

async function processPaddleText(
  job: ImageJob,
  text: string,
  env: Env,
  trace: InspectionTrace,
): Promise<ProcessResult> {
  trace.paddleOcrText = text;
  const expectedSale = numericSetting(env.EXPECTED_SALE_AMOUNT, "EXPECTED_SALE_AMOUNT");
  const expectedVoid = numericSetting(env.EXPECTED_VOID_AMOUNT, "EXPECTED_VOID_AMOUNT");
  const minConfidence = numericSetting(env.MIN_CONFIDENCE, "MIN_CONFIDENCE");
  const inspection = acceptWorkerPaymentName(
    inspectConfirmedReceiptText(text),
    text,
  );
  const decision = decideReceipt(
    inspection,
    expectedSale,
    expectedVoid,
    minConfidence,
  );
  const route = routePaddleOcrDecision(
    decision,
    inspection,
    expectedSale,
    expectedVoid,
  );
  updateTraceFromInspection(trace, inspection, "paddleocr");
  trace.providers.push("paddleocr");

  if (route === "pass") {
    const matchedAmount = inspection.observedAmounts.find(
      (amount) =>
        Math.abs(amount - expectedSale) < 0.005 ||
        Math.abs(amount - expectedVoid) < 0.005,
    ) ?? expectedSale;
    return replyKplusSuccess(job, matchedAmount, "paddleocr", env, trace);
  }
  if (route === "ignore") {
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "paddleocr-filter",
    }));
    return IGNORED_RESULT;
  }

  console.log(JSON.stringify({
    event: "paddleocr_fallback",
    webhookEventId: job.webhookEventId,
    reason: "partial-evidence",
    paddleMatchedKplus: inspection.isKplusReceipt,
    paddleHasSettlement: inspection.hasSettlement,
    paddleHasExpectedAmount: hasExpectedAmount(
      inspection,
      expectedSale,
      expectedVoid,
    ),
  }));

  const image = await downloadLineImage(
    job.messageId,
    env.LINE_CHANNEL_ACCESS_TOKEN,
  );
  return processImageJob(job, env, trace, {
    downloadedImage: image,
    paddleInspection: inspection,
  });
}

type PendingFailureRunResult =
  | { status: "stale" | "silent" | "suppressed" | "sent" }
  | { status: "waiting_for_images" }
  | { status: "waiting" | "busy"; retryAfterSeconds: number };

async function processPendingFailureFinalizer(
  finalizer: FailureFinalizeJob,
  env: Env,
  trace?: InspectionTrace,
): Promise<PendingFailureRunResult> {
  const coordinator = env.RECEIPT_ROUNDS.getByName(finalizer.roundKey);
  const result = await coordinator.finalizeFailure(finalizer);
  if (result.status === "stale" || result.status === "silent") {
    return { status: result.status };
  }
  if (result.status === "waiting" || result.status === "busy") {
    return {
      status: result.status,
      retryAfterSeconds: result.retryAfterSeconds ?? 1,
    };
  }
  if (result.status === "waiting_for_images") {
    return { status: result.status };
  }
  if (!result.job || !result.evidence) {
    await coordinator.completeFailureFinalization(finalizer);
    return { status: "silent" };
  }
  if (!isCurrentQueueJobDay(result.job)) {
    console.log(JSON.stringify({
      event: "pending_failure_expired",
      roundKey: finalizer.roundKey,
      messageId: result.job.messageId,
    }));
    await coordinator.completeFailureFinalization(finalizer);
    return { status: "silent" };
  }

  const deliveryTrace = trace ?? { providers: [], providerTimings: {} };
  try {
    const delivery = await replyKplusFailure(
      result.job,
      result.evidence.text,
      env,
      deliveryTrace,
    );
    if (delivery === "suppressed") {
      await coordinator.completeFailureFinalization(finalizer);
      return { status: "suppressed" };
    }
    await updateAuditLineDeliverySafely(env, result.job, "sent");
    await coordinator.completeFailureFinalization(finalizer);
    return { status: "sent" };
  } catch (error) {
    await coordinator.releaseFailureFinalization(finalizer);
    throw error;
  }
}

async function finalizeImageResult(
  job: ImageJob,
  initialResult: ProcessResult,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<void> {
  let result = initialResult;
  let pendingFailureRecord: Awaited<ReturnType<
    ReturnType<Env["RECEIPT_ROUNDS"]["getByName"]>["recordPendingFailure"]
  >> = null;
  if (result.outcome !== "pass" && result.evidence) {
    const roundKey = receiptRoundKey(job);
    if (roundKey) {
      pendingFailureRecord = await env.RECEIPT_ROUNDS.getByName(roundKey)
        .recordPendingFailure(
          job,
          { ...result.evidence, job },
          crypto.randomUUID(),
        );
    }
  }

  const pendingFailureFinalizer = await completeStockRoundImageAndGetFailureFinalizer(
    job,
    env,
  );
  const failureFinalizer = pendingFailureFinalizer ?? pendingFailureRecord?.finalizer;
  if (failureFinalizer) {
    const settled = await processPendingFailureFinalizer(
      failureFinalizer,
      env,
      trace,
    );
    if (settled.status === "waiting" && pendingFailureRecord?.shouldSchedule) {
      await scheduleFailureFinalizer(
        failureFinalizer,
        env,
        Math.min(FAILED_RESULT_WAIT_SECONDS, settled.retryAfterSeconds),
      );
    }
    if (settled.status === "suppressed") {
      trace.stage = "round-failure-suppression";
      trace.lineDeliveryStatus = "not_applicable";
      result = IGNORED_RESULT;
    }
  }
  trace.lineDeliveryStatus ??= result.evidence ? "pending" : "not_applicable";
  try {
    await markImageProcessed(job, d1StateStore(env.CONTROL_DB));
  } catch (error) {
    console.error(JSON.stringify({
      event: "processed_image_marker_failed",
      webhookEventId: job.webhookEventId,
      messageId: job.messageId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
  try {
    await d1StateStore(env.CONTROL_DB).delete(paddleStateKey(job));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "paddleocr_state_cleanup_failed",
      messageId: job.messageId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
  await recordStat(env, "processed");
  await recordStat(
    env,
    result.outcome === "pass"
      ? "passed"
      : result.outcome === "fail"
        ? "failed"
        : "ignored",
  );
  await recordAuditSafely(env, job, result.outcome, trace, startedAt);
}

async function processPaddlePoll(
  data: PaddlePollJob,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<"pending" | "finalized" | "fallback"> {
  const paddle = paddleTokenForJob(data.job, env);
  if (!paddle) {
    await processPaddleFallbackInline(
      data.job,
      "PADDLEOCR_TOKEN is not configured",
      env,
      trace,
      startedAt,
    );
    return "fallback";
  }
  let status: Awaited<ReturnType<typeof pollPaddleOcr>>;
  try {
    status = await timedProvider(
      trace,
      "paddleocr-poll",
      () => pollPaddleOcr(data.paddleJobId, paddle.token),
    );
  } catch (error) {
    await processPaddleFallbackInline(
      data.job,
      `PaddleOCR poll failed: ${queueErrorText(error)}`,
      env,
      trace,
      startedAt,
    );
    return "fallback";
  }
  if (status.state === "pending") {
    const pollCount = data.pollCount + 1;
    if (pollCount >= MAX_PADDLEOCR_POLLS) {
      await processPaddleFallbackInline(
        data.job,
        `PaddleOCR timed out after ${pollCount} polls`,
        env,
        trace,
        startedAt,
      );
      return "fallback";
    }
    try {
      await env.IMAGE_QUEUE.send({
        ...data,
        pollCount,
      }, { delaySeconds: PADDLEOCR_POLL_DELAY_SECONDS });
      await recordQueueStatSafely(env, "queueWrites", 1);
    } catch (error) {
      await processPaddleFallbackInline(
        data.job,
        `PaddleOCR retry queue failed: ${queueErrorText(error)}`,
        env,
        trace,
        startedAt,
      );
      return "fallback";
    }
    return "pending";
  }
  await finalizePaddleText(
    data.job,
    status.text ?? "",
    env,
    trace,
    startedAt,
  );
  return "finalized";
}

async function scheduleRoundFinalizer(
  finalizer: RoundFinalizeJob,
  env: Env,
  delaySeconds = ROUND_INACTIVITY_SECONDS,
): Promise<void> {
  try {
    await env.IMAGE_QUEUE.send(finalizer, { delaySeconds });
    await recordQueueStatSafely(env, "queueWrites", 1);
  } catch (error) {
    const detail = queueErrorText(error);
    const stored = await savePendingQueueJobs(
      env.CONTROL_DB,
      "images",
      [finalizer],
      detail,
    );
    console.error(JSON.stringify({
      event: "round_finalizer_deferred",
      roundKey: finalizer.roundKey,
      generation: finalizer.generation,
      stored,
      error: detail,
    }));
  }
}

async function scheduleFailureFinalizer(
  finalizer: FailureFinalizeJob,
  env: Env,
  delaySeconds = FAILED_RESULT_WAIT_SECONDS,
): Promise<void> {
  try {
    await env.IMAGE_QUEUE.send(finalizer, { delaySeconds });
    await recordQueueStatSafely(env, "queueWrites", 1);
  } catch (error) {
    const detail = queueErrorText(error);
    const stored = await savePendingQueueJobs(
      env.CONTROL_DB,
      "images",
      [finalizer],
      detail,
    );
    console.error(JSON.stringify({
      event: "failure_finalizer_deferred",
      roundKey: finalizer.roundKey,
      generation: finalizer.generation,
      stored,
      error: detail,
    }));
  }
}

async function registerStockRoundImage(job: ImageJob, env: Env): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  const finalizer = await env.RECEIPT_ROUNDS.getByName(roundKey).registerImage(
    job,
    crypto.randomUUID(),
  );
  if (!finalizer) return;

  const eventTimestamp = job.timestamp;
  const elapsedMs = typeof eventTimestamp === "number" && eventTimestamp > 0
    ? Math.max(0, Date.now() - eventTimestamp)
    : 0;
  const delaySeconds = Math.max(
    0,
    Math.ceil((ROUND_INACTIVITY_SECONDS * 1000 - elapsedMs) / 1000),
  );
  await scheduleRoundFinalizer(finalizer, env, delaySeconds);
}

async function completeStockRoundImage(job: ImageJob, env: Env): Promise<void> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return;
  await env.RECEIPT_ROUNDS.getByName(roundKey).completeImage(job);
}

async function completeStockRoundImageAndGetFailureFinalizer(
  job: ImageJob,
  env: Env,
): Promise<FailureFinalizeJob | null> {
  const roundKey = receiptRoundKey(job);
  if (!roundKey) return null;
  return env.RECEIPT_ROUNDS.getByName(roundKey)
    .completeImageAndGetFailureFinalizer(job);
}

async function processFailureFinalizer(
  finalizer: FailureFinalizeJob,
  env: Env,
): Promise<void> {
  const result = await processPendingFailureFinalizer(finalizer, env);
  if (result.status === "waiting" || result.status === "busy") {
    await scheduleFailureFinalizer(
      finalizer,
      env,
      Math.min(FAILED_RESULT_WAIT_SECONDS, result.retryAfterSeconds),
    );
    return;
  }
  if (result.status === "waiting_for_images") return;
  if (result.status === "sent") {
    console.log(JSON.stringify({
      event: "pending_failure_finalized",
      roundKey: finalizer.roundKey,
      generation: finalizer.generation,
    }));
  }
}

async function processRoundFinalizer(
  finalizer: RoundFinalizeJob,
  env: Env,
): Promise<void> {
  const coordinator = env.RECEIPT_ROUNDS.getByName(finalizer.roundKey);
  const result = await coordinator.finalize(finalizer);
  if (result.status === "stale") return;
  if (result.status === "waiting" || result.status === "busy") {
    await scheduleRoundFinalizer(finalizer, env, result.retryAfterSeconds ?? 1);
    return;
  }

  // A round that crossed the Bangkok calendar boundary is no longer useful
  // to the technician. Complete its state without sending a late reply.
  if (result.job && !isCurrentQueueJobDay(result.job)) {
    console.log(JSON.stringify({
      event: "round_finalizer_expired",
      roundKey: finalizer.roundKey,
      messageId: result.job.messageId,
    }));
    await coordinator.completeFinalization(finalizer);
    return;
  }

  try {
    if (result.job) {
      const delivery = await replyStockFlexOnce(
        result.job,
        env,
        { providers: [], providerTimings: {} },
      );
      if (delivery === "sent") {
        await updateAuditLineDeliverySafely(env, result.job, "sent");
      }
    }
    await coordinator.completeFinalization(finalizer);
  } catch (error) {
    if (result.job) {
      await updateAuditLineDeliverySafely(env, result.job, "failed");
    }
    await coordinator.releaseFinalization(finalizer);
    throw error;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const controlResponse = await handleControlRequest(request, env);
    if (controlResponse) return controlResponse;
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({ service: "kplus122-webhook", status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    await recordQueueStatSafely(env, "queueReads", batch.messages.length);
    let queueDeletes = 0;
    const acknowledge = (message: { ack(): void }): void => {
      message.ack();
      queueDeletes += 1;
    };
    for (const message of batch.messages) {
      const body = message.body;
      if (!isCurrentQueueJobDay(body)) {
        console.log(JSON.stringify({
          event: "queue_job_expired",
          kind: "kind" in body ? body.kind : "image",
          messageId: "messageId" in body ? body.messageId :
            "job" in body ? body.job.messageId : undefined,
        }));
        acknowledge(message);
        continue;
      }
      if (isLineWebhookQueueJob(body)) {
        try {
          await processQueuedWebhookEvents(body.events, env, body.receivedAtMs);
          acknowledge(message);
        } catch (error) {
          console.error(JSON.stringify({
            event: "webhook_queue_failed",
            receivedAtMs: body.receivedAtMs,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : "unknown error",
          }));
          message.retry({ delaySeconds: 5 });
        }
        continue;
      }

      if (isRoundFinalizeJob(body)) {
        try {
          await processRoundFinalizer(body, env);
          acknowledge(message);
        } catch (error) {
          console.error(JSON.stringify({
            event: "round_finalizer_failed",
            roundKey: body.roundKey,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : "unknown error",
          }));
          message.retry({ delaySeconds: 5 });
        }
        continue;
      }

      if (isFailureFinalizeJob(body)) {
        try {
          await processFailureFinalizer(body, env);
          acknowledge(message);
        } catch (error) {
          console.error(JSON.stringify({
            event: "failure_finalizer_failed",
            roundKey: body.roundKey,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : "unknown error",
          }));
          message.retry({ delaySeconds: 5 });
        }
        continue;
      }

      const job = isPaddlePollJob(body) || isOcrFallbackJob(body)
        ? body.job
        : body;
      const startedAt = Date.now();
      const trace: InspectionTrace = { providers: [], providerTimings: {} };
      try {
        if (isPaddlePollJob(body)) {
          await processPaddlePoll(body, env, trace, startedAt);
          acknowledge(message);
          continue;
        }

        if (isOcrFallbackJob(body)) {
          console.log(JSON.stringify({
            event: "ocr_fallback_started",
            messageId: job.messageId,
            reason: body.reason,
          }));
          const result = await processImageJob(job, env, trace);
          await finalizeImageResult(job, result, env, trace, startedAt);
          acknowledge(message);
          continue;
        }

        if (message.attempts === 1) await recordStat(env, "received");

        // Register the round only after the image job has safely reached the
        // image queue. This avoids leaving a pending round when a queue write
        // is deferred because the account quota is exhausted.
        await registerStockRoundImage(job, env);

        const operationalState = d1StateStore(env.CONTROL_DB);
        if (await isImageProcessed(job, operationalState)) {
          await recordStat(env, "duplicates");
          await recordStat(env, "ignored");
          trace.stage = "duplicate-suppression";
          console.log(JSON.stringify({
            event: "image_ignored",
            webhookEventId: job.webhookEventId,
            messageId: job.messageId,
            stage: "duplicate-suppression",
          }));
          await completeStockRoundImage(job, env);
          await recordAuditSafely(env, job, "ignored", trace, startedAt);
          acknowledge(message);
          continue;
        }

        if (!(await isProcessingEnabled(
          env.CONTROL_DB,
          String(env.PROCESSING_FORCE_DISABLED) === "true",
        ))) {
          trace.stage = "processing-disabled";
          console.log(JSON.stringify({
            event: "image_ignored",
            messageId: job.messageId,
            stage: "processing-disabled",
          }));
          await completeStockRoundImage(job, env);
          await markImageProcessed(job, operationalState);
          await recordStat(env, "processed");
          await recordStat(env, "ignored");
          await recordAuditSafely(env, job, "ignored", trace, startedAt);
          acknowledge(message);
          continue;
        }

        await submitPaddleJob(job, env, trace, startedAt);
        acknowledge(message);
      } catch (error) {
        await recordStat(env, "errors");
        trace.stage ??= "processing-error";
        await recordAuditSafely(
          env,
          job,
          "error",
          trace,
          startedAt,
          error instanceof Error ? error.message : "unknown error",
        );
        console.error(JSON.stringify({
          event: "image_processing_failed",
          messageId: job.messageId,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : "unknown error",
        }));
        message.retry({ delaySeconds: 30 });
      }
    }
    await recordQueueStatSafely(env, "queueDeletes", queueDeletes);
  },
  async scheduled(_controller, env): Promise<void> {
    const [stateRows, queueMarkerRows, imageSetBindingRows, inspectionRows, pendingQueue] = await Promise.all([
      purgeExpiredState(env.CONTROL_DB),
      purgeStaleImageQueueMarkers(env.CONTROL_DB),
      purgeExpiredImageSetBindings(env.CONTROL_DB),
      purgeExpiredInspectionLogs(env.CONTROL_DB),
      drainPendingQueueJobs(env),
    ]);
    console.log(JSON.stringify({
      event: "daily_cleanup_completed",
      stateRows,
      queueMarkerRows,
      imageSetBindingRows,
      inspectionRows,
      pendingQueue,
    }));
  },
} satisfies ExportedHandler<Env, QueueJob>;
