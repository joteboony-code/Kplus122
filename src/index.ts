import {
  acceptWorkerPaymentName,
  classifyKplusVisualCandidate,
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
  shouldReplyAfterGoogleVision,
  transcribeVisibleText,
} from "./analyze";
import { googleVisionOcr } from "./google-vision";
import {
  reserveGoogleVisionRequest,
} from "./google-vision-usage";
import { incrementDailyStat, type DailyStatName } from "./daily-stats";
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
import { isImageProcessed, markImageProcessed } from "./processing-state";
import {
  receiptRoundKey,
  ROUND_INACTIVITY_SECONDS,
  type RoundEvidence,
} from "./receipt-round";
export { ReceiptRoundCoordinator } from "./receipt-round-coordinator";
export { OperationalCounterCoordinator } from "./operational-counters";
import { d1StateStore, purgeExpiredState } from "./state-store";
import {
  DEFAULT_PADDLEOCR_MODEL,
  MAX_PADDLEOCR_POLLS,
  PADDLEOCR_POLL_DELAY_SECONDS,
  pollPaddleOcr,
  submitPaddleOcr,
} from "./paddle-ocr";
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
  isOcrFallbackJob,
  isPaddlePollJob,
  isRoundFinalizeJob,
  type ImageJob,
  type LineWebhookEvent,
  type LineWebhookBody,
  type OcrFallbackJob,
  type PaddlePollJob,
  type QueueJob,
  type ReceiptInspection,
  type RoundFinalizeJob,
} from "./types";

type ProcessOutcome = "pass" | "fail" | "ignored";
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
  trace.hasKplus = inspection.isKplusReceipt;
  trace.hasSettlement = inspection.hasSettlement;
  trace.observedAmounts = inspection.observedAmounts;
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

async function replyStockFlexOnce(
  job: ImageJob,
  env: Env,
  trace: InspectionTrace,
): Promise<"sent" | "suppressed"> {
  const includeStock = await claimStockFlex(job, env);
  if (!includeStock) return "suppressed";

  trace.lineDeliveryStatus = "pending";
  try {
    const sent = await sendReplyMessages(
      job,
      [stockFlexMessage(job.referenceCode)],
      env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!sent) throw new Error("LINE Stock Flex reply failed");
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
  try {
    method = await sendInspectionResultWithMethod(
      job,
      formatKplusSuccess(amount),
      env.LINE_CHANNEL_ACCESS_TOKEN,
      serviceAlert?.messages ?? [],
      includeStock,
    );
    if (!method) throw new Error("LINE inspection result delivery failed");
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
  try {
    const method = await sendInspectionResultWithMethod(
      job,
      text,
      env.LINE_CHANNEL_ACCESS_TOKEN,
      serviceAlert?.messages ?? [],
      includeStock,
    );
    if (method !== "reply") throw new Error("LINE inspection reply failed");
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
  if (!(await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as LineWebhookBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const operationalState = d1StateStore(env.CONTROL_DB);
  const imageEvents: LineWebhookEvent[] = [];
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
      );
      console.log(JSON.stringify({
        event: "job_reference_recorded",
        referenceCode,
        sourceType: event.source?.type,
      }));
      continue;
    }

    if (imageJobFromEvent(event)) imageEvents.push(event);
  }

  if (imageEvents.length > 0) {
    await env.LINE_WEBHOOKS.send({
      kind: "line-webhook",
      events: imageEvents,
      receivedAtMs: Date.now(),
    });
  }

  return Response.json({ accepted: imageEvents.length });
}

async function processQueuedWebhookEvents(
  events: LineWebhookEvent[],
  env: Env,
): Promise<void> {
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
    const job = imageJobFromEvent(event);
    if (!job) continue;
    const scope = conversationAndSenderFromEvent(event);
    if (scope) {
      job.referenceCode = await getJobReference(
        scope.conversationId,
        scope.senderId,
        operationalState,
      );
    }
    await registerStockRoundImage(job, env);
    jobs.push(job);
  }
  if (jobs.length > 0) {
    await env.IMAGE_QUEUE.sendBatch(jobs.map((body) => ({ body })));
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
        );
        updateTraceFromInspection(trace, ocrSpaceInspection, "ocr-space");
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
          reason: "expected-amount-not-found",
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
  const googleCandidate =
    hasPartialTextEvidence ||
    visualKplusCandidate;

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

async function enqueueOcrFallback(
  job: ImageJob,
  reason: string,
  env: Env,
): Promise<void> {
  await env.OCR_FALLBACK_QUEUE.send({
    kind: "ocr-fallback",
    job,
    reason: reason.slice(0, 500),
  });
  console.warn(JSON.stringify({
    event: "paddleocr_fallback_enqueued",
    messageId: job.messageId,
    reason,
  }));
}

async function submitPaddleJob(job: ImageJob, env: Env): Promise<void> {
  const token = env.PADDLEOCR_TOKEN?.trim();
  if (!token) {
    await enqueueOcrFallback(job, "PADDLEOCR_TOKEN is not configured", env);
    return;
  }

  const store = d1StateStore(env.CONTROL_DB);
  const key = paddleStateKey(job);
  let jobId = await store.get(key);
  try {
    if (!jobId) {
      const image = await downloadLineImage(
        job.messageId,
        env.LINE_CHANNEL_ACCESS_TOKEN,
      );
      jobId = await submitPaddleOcr(
        image,
        token,
        env.PADDLEOCR_MODEL?.trim() || DEFAULT_PADDLEOCR_MODEL,
      );
      await store.put(key, jobId, { expirationTtl: 24 * 60 * 60 });
      console.log(JSON.stringify({
        event: "paddleocr_submitted",
        messageId: job.messageId,
        paddleJobId: jobId,
      }));
    }
    await env.IMAGE_QUEUE.send({
      kind: "paddle-poll",
      job,
      paddleJobId: jobId,
      pollCount: 0,
    }, { delaySeconds: PADDLEOCR_POLL_DELAY_SECONDS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    await enqueueOcrFallback(job, `PaddleOCR submit failed: ${detail}`, env);
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

async function finalizeImageResult(
  job: ImageJob,
  initialResult: ProcessResult,
  env: Env,
  trace: InspectionTrace,
  startedAt: number,
): Promise<void> {
  let result = initialResult;
  if (result.outcome !== "pass" && result.evidence) {
    const delivery = await replyKplusFailure(
      job,
      result.evidence.text,
      env,
      trace,
    );
    if (delivery === "suppressed") {
      trace.stage = "round-failure-suppression";
      trace.lineDeliveryStatus = "not_applicable";
      result = IGNORED_RESULT;
    }
  }
  if (result.outcome === "ignored") await completeStockRoundImage(job, env);
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
  const token = env.PADDLEOCR_TOKEN?.trim();
  if (!token) {
    await enqueueOcrFallback(data.job, "PADDLEOCR_TOKEN is not configured", env);
    return "fallback";
  }
  let status: Awaited<ReturnType<typeof pollPaddleOcr>>;
  try {
    status = await timedProvider(
      trace,
      "paddleocr-poll",
      () => pollPaddleOcr(data.paddleJobId, token),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    await enqueueOcrFallback(data.job, `PaddleOCR failed: ${detail}`, env);
    return "fallback";
  }
  if (status.state === "pending") {
    const pollCount = data.pollCount + 1;
    if (pollCount >= MAX_PADDLEOCR_POLLS) {
      await enqueueOcrFallback(
        data.job,
        `PaddleOCR timed out after ${pollCount} polls`,
        env,
      );
      return "fallback";
    }
    await env.IMAGE_QUEUE.send({
      ...data,
      pollCount,
    }, { delaySeconds: PADDLEOCR_POLL_DELAY_SECONDS });
    return "pending";
  }
  const result = await processPaddleText(
    data.job,
    status.text!,
    env,
    trace,
  );
  await finalizeImageResult(data.job, result, env, trace, startedAt);
  return "finalized";
}

async function scheduleRoundFinalizer(
  finalizer: RoundFinalizeJob,
  env: Env,
  delaySeconds = ROUND_INACTIVITY_SECONDS,
): Promise<void> {
  await env.IMAGE_QUEUE.send(finalizer, { delaySeconds });
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
    for (const message of batch.messages) {
      const body = message.body;
      if (isLineWebhookQueueJob(body)) {
        try {
          await processQueuedWebhookEvents(body.events, env);
          message.ack();
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
          message.ack();
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

      const job = isPaddlePollJob(body) || isOcrFallbackJob(body)
        ? body.job
        : body;
      const startedAt = Date.now();
      const trace: InspectionTrace = { providers: [], providerTimings: {} };
      try {
        if (isPaddlePollJob(body)) {
          await processPaddlePoll(body, env, trace, startedAt);
          message.ack();
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
          message.ack();
          continue;
        }

        if (message.attempts === 1) await recordStat(env, "received");

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
          message.ack();
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
          message.ack();
          continue;
        }

        await submitPaddleJob(job, env);
        message.ack();
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
  },
  async scheduled(_controller, env): Promise<void> {
    const [stateRows, inspectionRows] = await Promise.all([
      purgeExpiredState(env.CONTROL_DB),
      purgeExpiredInspectionLogs(env.CONTROL_DB),
    ]);
    console.log(JSON.stringify({
      event: "daily_cleanup_completed",
      stateRows,
      inspectionRows,
    }));
  },
} satisfies ExportedHandler<Env, QueueJob>;
