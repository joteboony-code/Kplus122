import { afterEach, describe, expect, it, vi } from "vitest";
import {
  imageJobFromEvent,
  sendInspectionPushResult,
  sendInspectionResult,
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
});
