import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationAndSenderFromEvent,
  imageJobFromEvent,
  referenceCodeFromEvent,
  sendReplyMessages,
  sendInspectionResult,
  sendInspectionResultWithMethod,
  serviceLookContextFromEvent,
  stockFlexMessage,
  verifyLineSignature,
} from "../src/line";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("LINE webhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a valid LINE HMAC signature", async () => {
    const secret = "test-channel-secret";
    const body = new TextEncoder().encode('{"events":[]}');
    const bodyBuffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(bodyBuffer).set(body);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = bytesToBase64(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, body)),
    );

    expect(await verifyLineSignature(bodyBuffer, signature, secret)).toBe(true);
    expect(await verifyLineSignature(bodyBuffer, signature, "wrong-secret")).toBe(false);
  });

  it("creates jobs only for LINE-hosted image messages", () => {
    const job = imageJobFromEvent({
      type: "message",
      webhookEventId: "event-1",
      replyToken: "reply-token",
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      message: {
        id: "image-1",
        type: "image",
        quoteToken: "image-quote-token",
        contentProvider: { type: "line" },
        imageSet: { id: "set-10-images", index: 3, total: 10 },
      },
    });

    expect(job).toMatchObject({
      webhookEventId: "event-1",
      messageId: "image-1",
      quoteToken: "image-quote-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "user-1",
      imageSetId: "set-10-images",
      imageSetIndex: 3,
      imageSetTotal: 10,
    });
    expect(imageJobFromEvent({ type: "message", message: { type: "text" } })).toBeNull();
  });

  it("accepts only an exact 8-digit job reference and scopes it by conversation and sender", () => {
    const event = {
      type: "message",
      source: { type: "group" as const, groupId: "group-1", userId: "user-1" },
      message: { type: "text", text: "  12345678  " },
    };
    expect(referenceCodeFromEvent(event)).toBe("12345678");
    expect(conversationAndSenderFromEvent(event)).toEqual({
      conversationId: "group-1",
      senderId: "user-1",
    });
    expect(referenceCodeFromEvent({
      ...event,
      message: { type: "text", text: "งาน 12345678" },
    })).toBeNull();
    expect(referenceCodeFromEvent({
      ...event,
      message: { type: "text", text: "1234567" },
    })).toBeNull();
  });

  it("accepts the Service-look quick reply postback and text command", () => {
    const base = {
      webhookEventId: "event-service",
      replyToken: "reply-service",
      source: { type: "group" as const, groupId: "group-1", userId: "user-1" },
    };
    expect(serviceLookContextFromEvent({
      ...base,
      type: "postback",
      postback: { data: "action=service-look" },
    })).toMatchObject({
      replyTarget: "group-1",
      senderUserId: "user-1",
      serviceLookMode: "new",
    });
    expect(serviceLookContextFromEvent({
      ...base,
      type: "postback",
      postback: { data: "action=service-look-all" },
    })).toMatchObject({
      replyTarget: "group-1",
      senderUserId: "user-1",
      serviceLookMode: "all",
    });
    expect(serviceLookContextFromEvent({
      ...base,
      type: "message",
      message: { type: "text", text: " SERVICE-LOOK " },
    })).not.toBeNull();
    for (const command of [
      "เช็กงาน",
      "เช็คงาน",
      "เช็กservice",
      "เช็คservice",
      "เช็ก service",
      "เช็ค service",
    ]) {
      expect(serviceLookContextFromEvent({
        ...base,
        type: "message",
        message: { type: "text", text: command },
      })).not.toBeNull();
    }
    expect(serviceLookContextFromEvent({
      ...base,
      type: "postback",
      postback: { data: "action=other" },
    })).toBeNull();
  });

  it("mentions the image sender in a group reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendInspectionResult({
      webhookEventId: "event-1",
      messageId: "image-1",
      replyToken: "reply-token",
      quoteToken: "image-quote-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "ผลตรวจ", "channel-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<{
        type: string;
        text: string;
        quoteToken: string;
        substitution: { sender: { mentionee: { userId: string } } };
      }>;
    };
    expect(payload.messages[0]).toMatchObject({
      type: "textV2",
      quoteToken: "image-quote-token",
      text: "{sender}\nผลตรวจ",
      substitution: {
        sender: { mentionee: { userId: "U123" } },
      },
    });
  });

  it("uses normal text when the sender can't be mentioned", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendInspectionResult({
      webhookEventId: "event-2",
      messageId: "image-2",
      replyToken: "reply-token",
      replyTarget: "U123",
      sourceType: "user",
      senderUserId: "U123",
    }, "ผลตรวจ", "channel-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages[0]).toMatchObject({
      type: "text",
      text: "ผลตรวจ",
      quickReply: {
        items: [
          {
            action: {
              type: "uri",
              label: "📦 Stock",
              uri: "https://www.aomyim.me/app/eds",
            },
          },
          {
            action: {
              type: "postback",
              label: "🔍 Check Service",
              data: "action=service-look",
            },
          },
          {
            action: {
              type: "postback",
              label: "Service ทั้งหมด",
              data: "action=service-look-all",
            },
          },
        ],
      },
    });
  });

  it("adds the Service quick reply only to the last reply message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendReplyMessages({
      webhookEventId: "event-service",
      replyToken: "reply-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, [
      { type: "text", text: "first" },
      { type: "text", text: "last" },
    ], "channel-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages[0]).not.toHaveProperty("quickReply");
    expect(payload.messages[1]).toHaveProperty("quickReply");
  });

  it("replies when the slip inspection passes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handled = await sendInspectionResult({
      webhookEventId: "event-pass",
      messageId: "image-pass",
      replyToken: "reply-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "✅ ตรวจสอบผ่าน: พบสลิป KPLUS ยอด 1.22 บาท ข้อมูลถูกต้อง", "channel-token");

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.line.me/v2/bot/message/reply");
  });

  it("reports delivery failure without trying Push when Reply fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendInspectionResult({
      webhookEventId: "event-failed",
      messageId: "image-failed",
      replyToken: "expired-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "result", "channel-token");

    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.line.me/v2/bot/message/reply");
  });

  it("reports whether LINE used Reply", async () => {
    const replyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", replyFetch);
    const job = {
      webhookEventId: "event-method",
      messageId: "image-method",
      replyToken: "reply-token",
      replyTarget: "group-1",
      sourceType: "group" as const,
      senderUserId: "U123",
    };

    expect(await sendInspectionResultWithMethod(
      job,
      "result",
      "channel-token",
    )).toBe("reply");

    const failedReplyFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", failedReplyFetch);
    expect(await sendInspectionResultWithMethod(
      job,
      "result",
      "channel-token",
    )).toBeNull();
    expect(failedReplyFetch).toHaveBeenCalledTimes(1);
    expect(failedReplyFetch.mock.calls[0]?.[0]).toBe(
      "https://api.line.me/v2/bot/message/reply",
    );
  });

  it("does not append Stock Flex to an inspection result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = {
      webhookEventId: "event-stock-suppressed",
      messageId: "image-stock-suppressed",
      replyToken: "reply-token",
      replyTarget: "group-1",
      sourceType: "group" as const,
      senderUserId: "U123",
    };

    expect(await sendInspectionResultWithMethod(
      job,
      "ผลตรวจ",
      "channel-token",
    )).toBe("reply");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({ type: "textV2" });
    expect(payload.messages[0]).toHaveProperty("quickReply");
  });

  it("builds the Stock Flex used when an image has no inspection reply", () => {
    expect(stockFlexMessage()).toMatchObject({
      type: "flex",
      altText: "เปิด Stock เพื่อกรอกข้อมูลงาน",
      contents: {
        type: "bubble",
        footer: {
          contents: [{
            action: {
              type: "uri",
              label: "เปิด Stock",
              uri: "https://www.aomyim.me/app/eds",
            },
          }],
        },
      },
    });
  });

  it("sends the inspection result and Service alert in one Reply request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = {
      webhookEventId: "event-service-alert",
      messageId: "image-service-alert",
      replyToken: "reply-token",
      replyTarget: "group-1",
      sourceType: "group" as const,
      senderUserId: "U123",
    };

    expect(await sendInspectionResultWithMethod(
      job,
      "ผลตรวจ",
      "channel-token",
      [
        { type: "textV2", text: "{technician0} มีงานใหม่", substitution: {} },
        { type: "flex", altText: "งานใหม่", contents: { type: "bubble" } },
      ],
    )).toBe("reply");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]).toMatchObject({
      type: "textV2",
      text: "{sender}\nผลตรวจ",
    });
    expect(payload.messages[0]).not.toHaveProperty("quickReply");
    expect(payload.messages[1]).not.toHaveProperty("quickReply");
    expect(payload.messages[2]).toHaveProperty("quickReply");
  });
});
