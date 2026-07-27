import type {
  ImageJob,
  LineReplyContext,
  LineWebhookEvent,
} from "./types";

const LINE_API = "https://api.line.me";
const LINE_DATA_API = "https://api-data.line.me";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SERVICE_LOOK_POSTBACK_DATA = "action=service-look";
const SERVICE_LOOK_ALL_POSTBACK_DATA = "action=service-look-all";
const STOCK_URL = "https://www.aomyim.me/app/eds";
const SERVICE_LOOK_TEXT_COMMANDS = new Set([
  "service-look",
  "เช็กงาน",
  "เช็คงาน",
  "เช็กservice",
  "เช็คservice",
]);

function serviceLookQuickReply(): Record<string, unknown> {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "uri",
          label: "📦 Stock",
          uri: STOCK_URL,
        },
      },
      {
        type: "action",
        action: {
          type: "postback",
          label: "🔍 Check Service",
          data: SERVICE_LOOK_POSTBACK_DATA,
        },
      },
      {
        type: "action",
        action: {
          type: "postback",
          label: "Service ทั้งหมด",
          data: SERVICE_LOOK_ALL_POSTBACK_DATA,
        },
      },
    ],
  };
}

export function stockFlexMessage(tid?: string): Record<string, unknown> {
  const displayTid = /^\d{8}$/.test(tid ?? "") ? tid : "ไม่ระบุ";
  return {
    type: "flex",
    altText: "เปิด Stock เพื่อกรอกข้อมูลงาน",
    contents: {
      type: "bubble",
      size: "micro",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "📦 Stock",
            weight: "bold",
            size: "md",
            color: "#11884A",
          },
          {
            type: "text",
            text: `Tid: ${displayTid}`,
            weight: "bold",
            size: "sm",
            color: "#333333",
          },
          {
            type: "text",
            text: "ใส่ข้อมูลอุปกรณ์ ให้ร้านค้า/รับคืน",
            size: "xs",
            color: "#777777",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "10px",
        paddingTop: "0px",
        contents: [{
          type: "button",
          style: "primary",
          height: "sm",
          color: "#08A65C",
          action: {
            type: "uri",
            label: "เปิด Stock",
            uri: STOCK_URL,
          },
        }],
      },
    },
  };
}

function withServiceLookQuickReply(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return { ...message, quickReply: serviceLookQuickReply() };
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export async function verifyLineSignature(
  body: BufferSource,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(channelSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64(signature),
      body,
    );
  } catch {
    return false;
  }
}

export function imageJobFromEvent(event: LineWebhookEvent): ImageJob | null {
  if (
    event.type !== "message" ||
    event.message?.type !== "image" ||
    event.message.contentProvider?.type === "external" ||
    !event.message?.id ||
    !event.replyToken ||
    !event.webhookEventId
  ) {
    return null;
  }

  const replyTarget =
    event.source?.groupId ?? event.source?.roomId ?? event.source?.userId;

  return {
    webhookEventId: event.webhookEventId,
    messageId: event.message.id,
    replyToken: event.replyToken,
    quoteToken: event.message.quoteToken,
    replyTarget,
    sourceType: event.source?.type,
    senderUserId: event.source?.userId,
    timestamp: event.timestamp,
    imageSetId: event.message.imageSet?.id,
    imageSetIndex: event.message.imageSet?.index,
    imageSetTotal: event.message.imageSet?.total,
  };
}

export function referenceCodeFromEvent(event: LineWebhookEvent): string | null {
  if (event.type !== "message" || event.message?.type !== "text") return null;
  const match = event.message.text?.match(/^\s*(\d{8})\s*$/);
  return match?.[1] ?? null;
}

export interface ServiceLookContext extends LineReplyContext {
  serviceLookMode: "new" | "all";
}

export function serviceLookContextFromEvent(
  event: LineWebhookEvent,
): ServiceLookContext | null {
  const normalizedTextCommand = event.message?.type === "text"
    ? event.message.text?.trim().toLowerCase().replace(/\s+/g, "")
    : undefined;
  const isTextCommand =
    event.type === "message" &&
    event.message?.type === "text" &&
    normalizedTextCommand !== undefined &&
    SERVICE_LOOK_TEXT_COMMANDS.has(normalizedTextCommand);
  const isNewQuickReply =
    event.type === "postback" &&
    event.postback?.data === SERVICE_LOOK_POSTBACK_DATA;
  const isAllQuickReply =
    event.type === "postback" &&
    event.postback?.data === SERVICE_LOOK_ALL_POSTBACK_DATA;
  if (
    (!isTextCommand && !isNewQuickReply && !isAllQuickReply) ||
    !event.replyToken ||
    !event.webhookEventId
  ) {
    return null;
  }

  return {
    webhookEventId: event.webhookEventId,
    replyToken: event.replyToken,
    replyTarget:
      event.source?.groupId ?? event.source?.roomId ?? event.source?.userId,
    sourceType: event.source?.type,
    senderUserId: event.source?.userId,
    timestamp: event.timestamp,
    serviceLookMode: isAllQuickReply ? "all" : "new",
  };
}

export function conversationAndSenderFromEvent(
  event: LineWebhookEvent,
): { conversationId: string; senderId: string } | null {
  const conversationId =
    event.source?.groupId ?? event.source?.roomId ?? event.source?.userId;
  const senderId = event.source?.userId ?? conversationId;
  return conversationId && senderId ? { conversationId, senderId } : null;
}

async function downloadLineImageAtUrl(
  url: string,
  channelAccessToken: string,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`LINE image download failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Unexpected LINE content type: ${contentType || "unknown"}`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new Error(`LINE image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`LINE image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }

  return new Uint8Array(body);
}

export async function downloadLinePreview(
  messageId: string,
  channelAccessToken: string,
): Promise<Uint8Array> {
  const encodedId = encodeURIComponent(messageId);
  try {
    return await downloadLineImageAtUrl(
      `${LINE_DATA_API}/v2/bot/message/${encodedId}/content/preview`,
      channelAccessToken,
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: "preview_download_failed",
      messageId,
      error: error instanceof Error ? error.message : "unknown error",
    }));
    return downloadLineImage(messageId, channelAccessToken);
  }
}

export async function downloadLineImage(
  messageId: string,
  channelAccessToken: string,
): Promise<Uint8Array> {
  const encodedId = encodeURIComponent(messageId);
  return downloadLineImageAtUrl(
    `${LINE_DATA_API}/v2/bot/message/${encodedId}/content`,
    channelAccessToken,
  );
}

async function postLineMessage(
  path: string,
  channelAccessToken: string,
  payload: object,
): Promise<boolean> {
  const response = await fetch(`${LINE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.error(JSON.stringify({
      event: "line_message_failed",
      path,
      status: response.status,
    }));
    return false;
  }
  return true;
}

function inspectionMessage(job: ImageJob, text: string): object {
  const canMentionSender =
    (job.sourceType === "group" || job.sourceType === "room") &&
    Boolean(job.senderUserId);
  const quote = job.quoteToken ? { quoteToken: job.quoteToken } : {};
  const message = canMentionSender
    ? {
        type: "textV2",
        text: `{sender}\n${text}`,
        ...quote,
        substitution: {
          sender: {
            type: "mention",
            mentionee: { type: "user", userId: job.senderUserId },
          },
        },
      }
    : { type: "text", text, ...quote };
  return message;
}

function withQuickReplyOnLast(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.map((message, index) =>
    index === messages.length - 1
      ? withServiceLookQuickReply(message)
      : message
  );
}

export async function sendReplyMessages(
  context: LineReplyContext,
  messages: Record<string, unknown>[],
  channelAccessToken: string,
): Promise<boolean> {
  if (messages.length < 1 || messages.length > 5) {
    throw new Error("LINE reply requires 1-5 messages");
  }
  const withQuickReply = withQuickReplyOnLast(messages);
  return postLineMessage("/v2/bot/message/reply", channelAccessToken, {
    replyToken: context.replyToken,
    messages: withQuickReply,
  });
}

export async function sendInspectionResult(
  job: ImageJob,
  text: string,
  channelAccessToken: string,
): Promise<boolean> {
  return (await sendInspectionResultWithMethod(
    job,
    text,
    channelAccessToken,
  )) !== null;
}

export async function sendInspectionResultWithMethod(
  job: ImageJob,
  text: string,
  channelAccessToken: string,
  additionalMessages: Record<string, unknown>[] = [],
  includeStockFlex = true,
): Promise<"reply" | null> {
  const messages = [
    inspectionMessage(job, text) as Record<string, unknown>,
    ...additionalMessages,
    ...(includeStockFlex ? [stockFlexMessage(job.referenceCode)] : []),
  ];
  if (messages.length > 5) {
    throw new Error("LINE reply requires no more than 5 messages");
  }

  const replied = await postLineMessage(
    "/v2/bot/message/reply",
    channelAccessToken,
    {
      replyToken: job.replyToken,
      messages: withQuickReplyOnLast(messages),
    },
  );

  if (replied) return "reply";
  return null;
}
