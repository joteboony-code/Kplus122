import { describe, expect, it } from "vitest";
import { shouldReplyToIndividualFailure } from "../src/receipt-round";
import type { ImageJob } from "../src/types";

function job(
  messageId: string,
  sender = "U1",
  group = "G1",
  imageSetId?: string,
): ImageJob {
  return {
    webhookEventId: `event-${messageId}`,
    messageId,
    replyToken: `reply-${messageId}`,
    replyTarget: group,
    sourceType: "group",
    senderUserId: sender,
    imageSetId,
  };
}

describe("receipt round state", () => {
  it("does not reply fail from an individual image inside a LINE album", () => {
    expect(shouldReplyToIndividualFailure(job("one", "U1", "G1", "album-A"))).toBe(false);
    expect(shouldReplyToIndividualFailure(job("one"))).toBe(true);
  });
});
