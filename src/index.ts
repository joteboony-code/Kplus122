import {
  acceptWorkerPaymentName,
  classifyKplusVisualCandidate,
  decideReceipt,
  formatCompletedRound,
  formatDecision,
  hasKbankCandidateTextEvidence,
  hasGoogleCandidateTextEvidence,
  hasThaiQrPaymentText,
  inspectConfirmedReceiptText,
  inspectKbankReceiptText,
  inspectReceiptText,
  hasExpectedAmount,
  isValidKbankReceipt,
  shouldReplyAfterGoogleVision,
  transcribeVisibleText,
} from "./analyze";
import { googleVisionOcr } from "./google-vision";
import {
  hasGoogleVisionCapacity,
  recordGoogleVisionRequest,
} from "./google-vision-usage";
import { incrementDailyStat, type DailyStatName } from "./daily-stats";
import { ocrSpaceOcr } from "./ocr-space";
import {
  hasOcrSpaceCapacity,
  markOcrSpaceQuotaExhausted,
  recordOcrSpaceRequest,
} from "./ocr-space-usage";
import { handleControlRequest, isProcessingEnabled } from "./control";
import {
  downloadLineImage,
  imageJobFromEvent,
  sendInspectionResult,
  verifyLineSignature,
} from "./line";
import { hasRecentPass, recordRecentPass } from "./reply-state";
import { isImageProcessed, markImageProcessed } from "./processing-state";
import { recordReceiptEvidence, type ReceiptKind } from "./receipt-round";
import type { ImageJob, LineWebhookBody } from "./types";

type ProcessOutcome = "pass" | "fail" | "ignored";

async function recordStat(env: Env, name: DailyStatName): Promise<void> {
  try {
    await incrementDailyStat(env.REPLY_STATE, name);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "daily_stat_record_failed",
      stat: name,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
}

function numericSetting(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name} setting`);
  return parsed;
}

function representativeAmount(amounts: number[]): number {
  return amounts.reduce(
    (selected, amount) => Math.abs(amount) > Math.abs(selected) ? amount : selected,
    amounts[0] ?? 0,
  );
}

async function recordRoundCandidate(
  job: ImageJob,
  kind: ReceiptKind,
  amount: number,
  provider: string,
  env: Env,
): Promise<ProcessOutcome> {
  const round = await recordReceiptEvidence(
    env.REPLY_STATE,
    job,
    kind,
    amount,
  );

  if (!round.complete || round.kplusAmount === undefined || round.kbankAmount === undefined) {
    console.log(JSON.stringify({
      event: "receipt_round_pending",
      webhookEventId: job.webhookEventId,
      provider,
      recordedKind: kind,
      imageSetId: job.imageSetId,
      imageSetIndex: job.imageSetIndex,
      imageSetTotal: job.imageSetTotal,
      hasKplus: round.hasKplus,
      hasKbank: round.hasKbank,
    }));
    return "ignored";
  }

  await sendInspectionResult(
    job,
    formatCompletedRound(round.kplusAmount, round.kbankAmount),
    env.LINE_CHANNEL_ACCESS_TOKEN,
    String(env.ENABLE_PUSH_FALLBACK) === "true",
  );
  await recordRecentPass(job, env.REPLY_STATE);

  console.log(JSON.stringify({
    event: "receipt_round_completed",
    webhookEventId: job.webhookEventId,
    provider,
    imageSetId: job.imageSetId,
    imageSetTotal: job.imageSetTotal,
    kplusAmount: round.kplusAmount,
    kbankAmount: round.kbankAmount,
  }));
  return "pass";
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

  const jobs = (payload.events ?? [])
    .map(imageJobFromEvent)
    .filter((job): job is ImageJob => job !== null);

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

async function processImageJob(job: ImageJob, env: Env): Promise<ProcessOutcome> {
  const expectedSale = numericSetting(env.EXPECTED_SALE_AMOUNT, "EXPECTED_SALE_AMOUNT");
  const expectedVoid = numericSetting(env.EXPECTED_VOID_AMOUNT, "EXPECTED_VOID_AMOUNT");
  const minConfidence = numericSetting(env.MIN_CONFIDENCE, "MIN_CONFIDENCE");

  if (await hasRecentPass(job, env.REPLY_STATE)) {
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "recent-pass-suppression",
    }));
    return "ignored";
  }

  const original = await downloadLineImage(job.messageId, env.LINE_CHANNEL_ACCESS_TOKEN);

  if (env.OCR_SPACE_API_KEY && await hasOcrSpaceCapacity(env.REPLY_STATE)) {
    let ocrSpaceUsage = 0;
    let ocrSpaceResult: Awaited<ReturnType<typeof ocrSpaceOcr>> | null = null;
    try {
      await recordStat(env, "ocrSpaceCalls");
      ocrSpaceResult = await ocrSpaceOcr(original, env.OCR_SPACE_API_KEY);
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
      ocrSpaceUsage = await recordOcrSpaceRequest(env.REPLY_STATE);
      if (ocrSpaceResult.status === "quota-exhausted") {
        await recordStat(env, "ocrSpaceErrors");
        await markOcrSpaceQuotaExhausted(env.REPLY_STATE);
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
        const ocrSpaceHasAnyAmount = ocrSpaceInspection.observedAmounts.length > 0;
        const ocrSpaceKbankInspection = inspectKbankReceiptText(ocrSpaceResult.text);

        if (isValidKbankReceipt(ocrSpaceKbankInspection)) {
          return recordRoundCandidate(
            job,
            "kbank",
            representativeAmount(ocrSpaceKbankInspection.observedAmounts),
            "ocr-space",
            env,
          );
        }

        if (ocrSpaceDecision.status === "pass") {
          const matchedAmount = ocrSpaceInspection.observedAmounts.find(
            (amount) =>
              Math.abs(amount - expectedSale) < 0.005 ||
              Math.abs(amount - expectedVoid) < 0.005,
          ) ?? expectedSale;
          return recordRoundCandidate(
            job,
            "kplus",
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
          if (await hasRecentPass(job, env.REPLY_STATE)) {
            console.log(JSON.stringify({
              event: "image_ignored",
              webhookEventId: job.webhookEventId,
              stage: "recent-pass-suppression",
              ocrProvider: "ocr-space",
            }));
            return "ignored";
          }

          await sendInspectionResult(
            job,
            formatDecision(ocrSpaceInspection, ocrSpaceDecision),
            env.LINE_CHANNEL_ACCESS_TOKEN,
            String(env.ENABLE_PUSH_FALLBACK) === "true",
          );
          console.log(JSON.stringify({
            event: "receipt_processed",
            webhookEventId: job.webhookEventId,
            status: ocrSpaceDecision.status,
            confidence: ocrSpaceInspection.confidence,
            hasSettlement: ocrSpaceInspection.hasSettlement,
            ocrProvider: "ocr-space",
            ocrSpaceUsage,
          }));
          return "fail";
        }

        const ocrSpaceCandidate = hasGoogleCandidateTextEvidence(
          inspectReceiptText(ocrSpaceResult.text),
          expectedSale,
          expectedVoid,
          ocrSpaceResult.text,
        ) || hasKbankCandidateTextEvidence(ocrSpaceResult.text);

        if (!ocrSpaceCandidate) {
          console.log(JSON.stringify({
            event: "image_ignored",
            webhookEventId: job.webhookEventId,
            stage: "ocr-space-filter",
            ocrSpaceUsage,
          }));
          return "ignored";
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
    workerText = await transcribeVisibleText(env.AI, original);
  } catch (error) {
    await recordStat(env, "workersAiErrors");
    throw error;
  }
  const workerKbankInspection = inspectKbankReceiptText(workerText);
  if (isValidKbankReceipt(workerKbankInspection)) {
    return recordRoundCandidate(
      job,
      "kbank",
      representativeAmount(workerKbankInspection.observedAmounts),
      "workers-ai",
      env,
    );
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

  if (workerDecision.status === "pass") {
    const matchedAmount = acceptedWorkerInspection.observedAmounts.find(
      (amount) =>
        Math.abs(amount - expectedSale) < 0.005 ||
        Math.abs(amount - expectedVoid) < 0.005,
    ) ?? expectedSale;
    return recordRoundCandidate(
      job,
      "kplus",
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
  const workerKbankCandidate = hasKbankCandidateTextEvidence(workerText);
  const visualClassifierAttempted = !hasPartialTextEvidence && !workerKbankCandidate;
  let visualKplusCandidate = false;
  if (visualClassifierAttempted) {
    try {
      await recordStat(env, "workersAiCalls");
      visualKplusCandidate = await classifyKplusVisualCandidate(env.AI, original);
    } catch (error) {
      await recordStat(env, "workersAiErrors");
      throw error;
    }
  }
  const googleCandidate =
    hasPartialTextEvidence ||
    workerKbankCandidate ||
    visualKplusCandidate;

  if (!googleCandidate) {
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
    return "ignored";
  }

  if (!env.GOOGLE_VISION_API_KEY) {
    throw new Error("GOOGLE_VISION_API_KEY is required for fallback inspection");
  }

  if (!(await hasGoogleVisionCapacity(env.REPLY_STATE))) {
    await recordStat(env, "googleVisionCapSkips");
    console.warn(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "google-vision-monthly-cap",
    }));
    return "ignored";
  }

  let receiptText: string;
  try {
    await recordStat(env, "googleVisionCalls");
    receiptText = await googleVisionOcr(original, env.GOOGLE_VISION_API_KEY);
  } catch (error) {
    await recordStat(env, "googleVisionErrors");
    throw error;
  }
  let googleVisionUsage: number | null = null;
  try {
    googleVisionUsage = await recordGoogleVisionRequest(env.REPLY_STATE);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "google_vision_usage_record_failed",
      webhookEventId: job.webhookEventId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  }
  const googleKbankInspection = inspectKbankReceiptText(receiptText);
  if (isValidKbankReceipt(googleKbankInspection)) {
    return recordRoundCandidate(
      job,
      "kbank",
      representativeAmount(googleKbankInspection.observedAmounts),
      "google-vision",
      env,
    );
  }
  const inspection = inspectConfirmedReceiptText(receiptText);
  const decision = decideReceipt(
    inspection,
    expectedSale,
    expectedVoid,
    minConfidence,
  );

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
    return "ignored";
  }

  if (decision.status === "pass") {
    const matchedAmount = inspection.observedAmounts.find(
      (amount) =>
        Math.abs(amount - expectedSale) < 0.005 ||
        Math.abs(amount - expectedVoid) < 0.005,
    ) ?? expectedSale;
    return recordRoundCandidate(
      job,
      "kplus",
      matchedAmount,
      "google-vision",
      env,
    );
  }

  if (await hasRecentPass(job, env.REPLY_STATE)) {
    console.log(JSON.stringify({
      event: "image_ignored",
      webhookEventId: job.webhookEventId,
      stage: "recent-pass-suppression",
      pendingStatus: decision.status,
      ocrProvider: "google-vision",
    }));
    return "ignored";
  }

  await sendInspectionResult(
    job,
    formatDecision(inspection, decision),
    env.LINE_CHANNEL_ACCESS_TOKEN,
    String(env.ENABLE_PUSH_FALLBACK) === "true",
  );
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
  return "fail";
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
      try {
        if (message.attempts === 1) await recordStat(env, "received");

        if (await isImageProcessed(message.body, env.REPLY_STATE)) {
          await recordStat(env, "duplicates");
          await recordStat(env, "ignored");
          console.log(JSON.stringify({
            event: "image_ignored",
            webhookEventId: message.body.webhookEventId,
            messageId: message.body.messageId,
            stage: "duplicate-suppression",
          }));
          message.ack();
          continue;
        }

        if (!(await isProcessingEnabled(
          env.CONTROL_DB,
          String(env.PROCESSING_FORCE_DISABLED) === "true",
        ))) {
          console.log(JSON.stringify({
            event: "image_ignored",
            messageId: message.id,
            stage: "processing-disabled",
          }));
          await markImageProcessed(message.body, env.REPLY_STATE);
          await recordStat(env, "processed");
          await recordStat(env, "ignored");
          message.ack();
          continue;
        }

        const outcome = await processImageJob(message.body, env);
        try {
          await markImageProcessed(message.body, env.REPLY_STATE);
        } catch (error) {
          console.error(JSON.stringify({
            event: "processed_image_marker_failed",
            webhookEventId: message.body.webhookEventId,
            messageId: message.body.messageId,
            error: error instanceof Error ? error.message : "unknown error",
          }));
        }
        await recordStat(env, "processed");
        await recordStat(
          env,
          outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "ignored",
        );
        message.ack();
      } catch (error) {
        await recordStat(env, "errors");
        console.error(JSON.stringify({
          event: "image_processing_failed",
          messageId: message.id,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : "unknown error",
        }));
        message.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env, ImageJob>;
