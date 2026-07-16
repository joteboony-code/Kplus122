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
}

export interface ImageJob {
  webhookEventId: string;
  messageId: string;
  replyToken: string;
  quoteToken?: string;
  replyTarget?: string;
  sourceType?: "user" | "group" | "room";
  senderUserId?: string;
  timestamp?: number;
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

export type QueueJob = ImageJob | RoundFinalizeJob;

export function isRoundFinalizeJob(job: QueueJob): job is RoundFinalizeJob {
  return "kind" in job && job.kind === "round-finalize";
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
