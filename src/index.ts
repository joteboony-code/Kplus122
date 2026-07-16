import {
  acceptWorkerPaymentName,
  classifyKplusVisualCandidate,
  decideReceipt,
  formatKplusSuccess,
  formatDecision,
  hasGoogleCandidateTextEvidence,
  hasThaiQrPaymentText,
  inspectConfirmedReceiptText,
  inspectReceiptText,
  hasExpectedAmount,
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
  type InspectionTrace,
} from "./audit-log";
import { getJobReference, storeJobReference } from "./job-reference";
import {
  conversationAndSenderFromEvent,
  downloadLineImage,
  imageJobFromEvent,
  referenceCodeFromEvent,
  sendInspectionPushResult,
  sendInspectionResult,
  verifyLineSignature,
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
  isRoundFinalizeJob,
  type ImageJob,
  type LineWebhookBody,
  type QueueJob,
  type RoundFinalizeJob,
} from "./types";

type ProcessOutcome = "pass" | "fail" | "ignored";
interface ProcessResult {
  outcome: ProcessOutcome;
  evidence?: Omit<RoundEvidence, "job">;
}

const IGNORED_RESULT: ProcessResult = { outcome: "ignored" };

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

async function replyKplusSuccess(
  job: ImageJob,
  amount: number,
  provider: string,
  env: Env,
): Promise<ProcessResult> {
  const roundKey = receiptRoundKey(job);
  if (roundKey) {
    const claim = await env.RECEIPT_ROUNDS.getByName(roundKey).claimPass(job);
    if (claim === "suppressed") return IGNORED_RESULT;
    if (claim === "busy") throw new Error("Pass delivery is already in progress");
  }

  let sent = false;
  try {
    sent = await sendInspectionResult(
      job,
      formatKplusSuccess(amount),
      env.LINE_CHANNEL_ACCESS_TOKEN,
      String(env.ENABLE_PUSH_FALLBACK) === "true",
    );
    if (!sent) throw new Error("LINE inspection result delivery failed");
  } catch (error) {
    if (roundKey) {
      await env.RECEIPT_ROUNDS.getByName(roundKey).releasePass(job);
    }
    throw error;
  }
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
  const jobs: ImageJob[] = [];
  for (const event of payload.events ?? []) {
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

    const job = imageJobFromEvent(event);
    if (!job) continue;
    if (scope) {
      job.referenceCode = await getJobReference(
        scope.conversationId,
        scope.senderId,
        operationalState,
      );
    }
    jobs.push(job);
  }

  if (!(await isProcessingEnabled(
    env.CONTROL_DB,
    String(env.PROCESSING_FORCE_DISABLED) === "true",
  ))) {
    console.log(JSON.stringify({
      event: "webhook_images_skipped",
      reason: "processing-disabled",
      imageCount: jobs.length,
    }));
    return Response.json({ accepted: 0, processingEnabled: false });
  }

  if (jobs.length > 0) {
    await env.IMAGE_QUEUE.sendBatch(jobs.map((body) => ({ body })));
  }

  return Response.json({ accepted: jobs.length });
}

async function processImageJob(
  job: ImageJob,
  env: Env,
  trace: InspectionTrace,
): Promise<ProcessResult> {
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

  const original = await downloadLineImage(job.messageId, env.LINE_CHANNEL_ACCESS_TOKEN);

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
        updateTraceFromInspection(trace, ocrSpaceInspection, "ocr-space");
        const ocrSpaceHasAnyAmount = ocrSpaceInspection.observedAmounts.length > 0;
        if (ocrSpaceDecision.status === "pass") {
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
          );
        }

        if (
          ocrSpaceInspection.isKplusReceipt &&
          ocrSpaceInspection.hasSettlement &&
          ocrSpaceHasAnyAmount
        ) {
          if (await hasRecentPass(job, d1StateStore(env.CONTROL_DB))) {
            console.log(JSON.stringify({
              event: "image_ignored",
              webhookEventId: job.webhookEventId,
              stage: "recent-pass-suppression",
              ocrProvider: "ocr-space",
            }));
            return IGNORED_RESULT;
          }

          console.log(JSON.stringify({
            event: "receipt_processed",
            webhookEventId: job.webhookEventId,
            status: ocrSpaceDecision.status,
            confidence: ocrSpaceInspection.confidence,
            hasSettlement: ocrSpaceInspection.hasSettlement,
            ocrProvider: "ocr-space",
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

        const ocrSpaceCandidate = hasGoogleCandidateTextEvidence(
          inspectReceiptText(ocrSpaceResult.text),
          expectedSale,
          expectedVoid,
          ocrSpaceResult.text,
        );

        if (!ocrSpaceCandidate) {
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
          reason: "partial-evidence",
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
    if (inspection.isKplusReceipt) {
      return {
        outcome: "fail",
        evidence: {
          kind: "uncertain",
          text: formatDecision(inspection, {
            status: "uncertain",
            failures: ["ข้อมูล KPLUS ไม่ชัดเจน"],
          }),
        },
      };
    }
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

async function processRoundFinalizer(
  job: RoundFinalizeJob,
  env: Env,
): Promise<void> {
  const result = await env.RECEIPT_ROUNDS.getByName(job.roundKey).finalize(job);
  if (result.status === "waiting" || result.status === "busy") {
    await env.IMAGE_QUEUE.send(job, {
      delaySeconds: result.retryAfterSeconds ?? ROUND_INACTIVITY_SECONDS,
    });
    return;
  }
  if (result.status !== "finalized") return;

  try {
    if (result.evidence) {
      const sent = await sendInspectionPushResult(
        result.evidence.job,
        result.evidence.text,
        env.LINE_CHANNEL_ACCESS_TOKEN,
      );
      if (!sent) throw new Error("LINE round summary delivery failed");
    }
    await env.RECEIPT_ROUNDS.getByName(job.roundKey).completeFinalization(job);
  } catch (error) {
    await env.RECEIPT_ROUNDS.getByName(job.roundKey).releaseFinalization(job);
    throw error;
  }
  console.log(JSON.stringify({
    event: "receipt_round_finalized",
    roundKey: job.roundKey,
    result: result.evidence?.kind ?? "silent-no-kplus",
  }));
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
      if (isRoundFinalizeJob(message.body)) {
        try {
          await processRoundFinalizer(message.body, env);
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({
            event: "receipt_round_finalizer_failed",
            roundKey: message.body.roundKey,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : "unknown error",
          }));
          message.retry({ delaySeconds: 30 });
        }
        continue;
      }

      const job = message.body;
      const startedAt = Date.now();
      const trace: InspectionTrace = { providers: [], providerTimings: {} };
      try {
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
          await markImageProcessed(job, operationalState);
          await recordStat(env, "processed");
          await recordStat(env, "ignored");
          await recordAuditSafely(env, job, "ignored", trace, startedAt);
          message.ack();
          continue;
        }

        const result = await processImageJob(job, env, trace);
        const roundKey = receiptRoundKey(job);
        if (result.outcome !== "pass") {
          const finalizer = roundKey
            ? await env.RECEIPT_ROUNDS.getByName(roundKey).recordActivity(
                job,
                result.evidence ? { ...result.evidence, job } : undefined,
                crypto.randomUUID(),
              )
            : null;
          if (finalizer) {
            await env.IMAGE_QUEUE.send(finalizer, {
              delaySeconds: ROUND_INACTIVITY_SECONDS,
            });
          } else if (!roundKey && result.evidence) {
            const sent = await sendInspectionResult(
              job,
              result.evidence.text,
              env.LINE_CHANNEL_ACCESS_TOKEN,
              String(env.ENABLE_PUSH_FALLBACK) === "true",
            );
            if (!sent) throw new Error("LINE inspection result delivery failed");
          }
        }
        try {
          await markImageProcessed(job, operationalState);
        } catch (error) {
          console.error(JSON.stringify({
            event: "processed_image_marker_failed",
            webhookEventId: job.webhookEventId,
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
