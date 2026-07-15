import { describe, expect, it } from "vitest";
import {
  RECENT_PASS_TTL_SECONDS,
  recentPassKey,
  recentPassTtl,
} from "../src/reply-state";
import type { ImageJob } from "../src/types";

function job(overrides: Partial<ImageJob> = {}): ImageJob {
  return {
    webhookEventId: "event-1",
    messageId: "message-1",
    replyToken: "reply-1",
    replyTarget: "group-1",
    senderUserId: "user-1",
    sourceType: "group",
    ...overrides,
  };
}

describe("recent pass suppression", () => {
  it("scopes a pass to the conversation and sender", () => {
    expect(recentPassKey(job())).toBe("recent-pass:v4:group-1:user-1:no-reference");
    expect(recentPassKey(job({ senderUserId: "user-2" }))).not.toBe(
      recentPassKey(job()),
    );
  });

  it("suppresses later albums in the same one-minute sender round", () => {
    expect(recentPassKey(job({ imageSetId: "album-A" }))).toBe(
      recentPassKey(job({ imageSetId: "album-B" })),
    );
    expect(recentPassTtl(job({ imageSetId: "album-A" }))).toBe(60);
  });

  it("supports direct chats and expires after one minute", () => {
    expect(recentPassKey(job({
      replyTarget: "user-1",
      senderUserId: "user-1",
      sourceType: "user",
    }))).toBe("recent-pass:v4:user-1:user-1:no-reference");
    expect(RECENT_PASS_TTL_SECONDS).toBe(60);
    expect(recentPassTtl(job())).toBe(60);
  });

  it("does not suppress a new 8-digit job after the prior job passed", () => {
    expect(recentPassKey(job({ referenceCode: "12345678" }))).not.toBe(
      recentPassKey(job({ referenceCode: "87654321" })),
    );
  });

  it("does not suppress when LINE omitted the conversation identity", () => {
    expect(recentPassKey(job({ replyTarget: undefined, senderUserId: undefined }))).toBeNull();
  });
});
