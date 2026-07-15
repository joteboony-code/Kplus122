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
}

export interface ReceiptInspection {
  isKplusReceipt: boolean;
  hasSettlement: boolean;
  observedAmounts: number[];
  confidence: number;
  reason: string;
}

export interface ReceiptDecision {
  status: "pass" | "fail" | "uncertain";
  failures: string[];
}
