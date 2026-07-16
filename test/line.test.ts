import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationAndSenderFromEvent,
  imageJobFromEvent,
  referenceCodeFromEvent,
  sendInspectionPushResult,
  sendInspectionResult,
  sendInspectionResultWithMethod,
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
    }, "ผลตรวจ", "channel-token", false);

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
    }, "ผลตรวจ", "channel-token", false);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<{ type: string; text: string }>;
    };
    expect(payload.messages[0]).toEqual({ type: "text", text: "ผลตรวจ" });
  });

  it("uses push for an end-of-round summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendInspectionPushResult({
      webhookEventId: "event-3",
      messageId: "image-3",
      replyToken: "expired-reply-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "round summary", "channel-token");

    expect(sent).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.line.me/v2/bot/message/push");
  });

  it("reports delivery failure when reply and fallback are unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendInspectionResult({
      webhookEventId: "event-failed",
      messageId: "image-failed",
      replyToken: "expired-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "result", "channel-token", false);

    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports success only when push fallback succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendInspectionResult({
      webhookEventId: "event-fallback",
      messageId: "image-fallback",
      replyToken: "expired-token",
      replyTarget: "group-1",
      sourceType: "group",
      senderUserId: "U123",
    }, "result", "channel-token", true);

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports whether LINE used Reply or Push", async () => {
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
      true,
    )).toBe("reply");

    const pushFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", pushFetch);
    expect(await sendInspectionResultWithMethod(
      job,
      "result",
      "channel-token",
      true,
    )).toBe("push");
  });
});
