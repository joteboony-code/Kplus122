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
    expect(recentPassKey(job())).toBe("recent-pass:v2:group-1:user-1:fallback");
    expect(recentPassKey(job({ senderUserId: "user-2" }))).not.toBe(
      recentPassKey(job()),
    );
  });

  it("suppresses only the completed LINE image set", () => {
    expect(recentPassKey(job({ imageSetId: "album-A" }))).toBe(
      "recent-pass:v2:group-1:user-1:image-set:album-A",
    );
    expect(recentPassKey(job({ imageSetId: "album-A" }))).not.toBe(
      recentPassKey(job({ imageSetId: "album-B" })),
    );
  });

  it("supports direct chats and expires after one minute", () => {
    expect(recentPassKey(job({
      replyTarget: "user-1",
      senderUserId: "user-1",
      sourceType: "user",
    }))).toBe("recent-pass:v2:user-1:user-1:fallback");
    expect(RECENT_PASS_TTL_SECONDS).toBe(60);
  });

  it("does not suppress when LINE omitted the conversation identity", () => {
    expect(recentPassKey(job({ replyTarget: undefined, senderUserId: undefined }))).toBeNull();
  });
});
