import { describe, expect, it } from "vitest";
import { RECENT_PASS_TTL_SECONDS, recentPassKey } from "../src/reply-state";
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
    expect(recentPassKey(job())).toBe("recent-pass:group-1:user-1");
    expect(recentPassKey(job({ senderUserId: "user-2" }))).not.toBe(
      recentPassKey(job()),
    );
  });

  it("supports direct chats and expires after one minute", () => {
    expect(recentPassKey(job({
      replyTarget: "user-1",
      senderUserId: "user-1",
      sourceType: "user",
    }))).toBe("recent-pass:user-1:user-1");
    expect(RECENT_PASS_TTL_SECONDS).toBe(60);
  });

  it("does not suppress when LINE omitted the conversation identity", () => {
    expect(recentPassKey(job({ replyTarget: undefined, senderUserId: undefined }))).toBeNull();
  });
});
