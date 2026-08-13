export interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  replyToken?: string;
  source?: {
    type?: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    quoteToken?: string;
    contentProvider?: {
      type?: "line" | "external";
    };
    imageSet?: {
      id?: string;
      index?: number;
      total?: number;
    };
  };
  postback?: {
    data?: string;
    params?: Record<string, string>;
  };
}

export interface LineReplyContext {
  webhookEventId: string;
  replyToken: string;
  replyTarget?: string;
  sourceType?: "user" | "group" | "room";
  senderUserId?: string;
  timestamp?: number;
}

export interface ImageJob extends LineReplyContext {
  messageId: string;
  quoteToken?: string;
  /** Timestamp when LINE delivered the webhook, used for Reply-token ordering. */
  replyTokenReceivedAtMs?: number;
  imageSetId?: string;
  imageSetIndex?: number;
  imageSetTotal?: number;
  referenceCode?: string;
}

export interface RoundFinalizeJob {
  kind: "round-finalize";
  roundKey: string;
  generation: string;
}

export interface FailureFinalizeJob {
  kind: "failure-finalize";
  roundKey: string;
  generation: string;
}

export interface LineWebhookQueueJob {
  kind: "line-webhook";
  events: LineWebhookEvent[];
  receivedAtMs: number;
}

export interface PaddlePollJob {
  kind: "paddle-poll";
  job: ImageJob;
  paddleJobId: string;
  pollCount: number;
}

export interface OcrFallbackJob {
  kind: "ocr-fallback";
  job: ImageJob;
  reason: string;
}

export type QueueJob =
  | ImageJob
  | RoundFinalizeJob
  | FailureFinalizeJob
  | LineWebhookQueueJob
  | PaddlePollJob
  | OcrFallbackJob;

export function isRoundFinalizeJob(job: QueueJob): job is RoundFinalizeJob {
  return "kind" in job && job.kind === "round-finalize";
}

export function isFailureFinalizeJob(job: QueueJob): job is FailureFinalizeJob {
  return "kind" in job && job.kind === "failure-finalize";
}

export function isLineWebhookQueueJob(job: QueueJob): job is LineWebhookQueueJob {
  return "kind" in job && job.kind === "line-webhook";
}

export function isPaddlePollJob(job: QueueJob): job is PaddlePollJob {
  return "kind" in job && job.kind === "paddle-poll";
}

export function isOcrFallbackJob(job: QueueJob): job is OcrFallbackJob {
  return "kind" in job && job.kind === "ocr-fallback";
}

export interface ReceiptInspection {
  isKplusReceipt: boolean;
  hasSettlement: boolean;
  observedAmounts: number[];
  labeledAmounts: number[];
  confidence: number;
  reason: string;
}

export interface ReceiptDecision {
  status: "pass" | "fail" | "uncertain";
  failures: string[];
}
