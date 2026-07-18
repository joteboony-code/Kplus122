import { describe, expect, it, vi } from "vitest";
import {
  fetchCastleServiceSnapshot,
  formatServiceLookMessages,
  loadSeenServiceJobKeys,
  saveSeenServiceJobs,
  selectNewServiceJobs,
  type CastleServiceJob,
} from "../src/service-look";
import type { StateStore } from "../src/state-store";

function job(index: number): CastleServiceJob {
  return {
    jobNumber: `SERV-${index}`,
    terminalId: `TID-${index}`,
    merchantName: `ร้าน ${index}`,
    province: "ชลบุรี",
    district: "เมืองชลบุรี",
    status: "OPEN",
    slaDate: "18/07/2569 12:00",
    link: `https://www.castles-th.com/jobs/${index}`,
  };
}

function memoryStore(): StateStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  };
}

describe("Service-look", () => {
  it("reads and normalizes the current Castle RPC snapshot", async () => {
    const getCurrentJobs = vi.fn().mockResolvedValue({
      checkedAt: "2026-07-18T03:00:00.000Z",
      totalJobs: 2,
      jobs: [job(1), job(2)],
    });
    const snapshot = await fetchCastleServiceSnapshot({ getCurrentJobs });
    expect(getCurrentJobs).toHaveBeenCalledOnce();
    expect(snapshot.totalJobs).toBe(2);
    expect(snapshot.jobs.map((item) => item.jobNumber)).toEqual(["SERV-1", "SERV-2"]);
  });

  it("keeps seen jobs separate for each LINE group", async () => {
    const store = memoryStore();
    const snapshot = { checkedAt: "", totalJobs: 2, jobs: [job(1), job(2)] };

    const groupASeen = await loadSeenServiceJobKeys(store, "group-a");
    const groupANew = selectNewServiceJobs(snapshot, groupASeen);
    await saveSeenServiceJobs(
      store,
      "group-a",
      snapshot,
      groupASeen,
      groupANew,
    );

    expect(selectNewServiceJobs(
      snapshot,
      await loadSeenServiceJobKeys(store, "group-a"),
    )).toHaveLength(0);
    expect(selectNewServiceJobs(
      snapshot,
      await loadSeenServiceJobKeys(store, "group-b"),
    )).toHaveLength(2);
  });

  it("allows a closed job to appear again if Castle reopens it", async () => {
    const store = memoryStore();
    const first = { checkedAt: "", totalJobs: 1, jobs: [job(1)] };
    const firstSeen = await loadSeenServiceJobKeys(store, "group-a");
    await saveSeenServiceJobs(store, "group-a", first, firstSeen, first.jobs);

    const empty = { checkedAt: "", totalJobs: 0, jobs: [] };
    const afterFirst = await loadSeenServiceJobKeys(store, "group-a");
    await saveSeenServiceJobs(store, "group-a", empty, afterFirst, []);

    expect(selectNewServiceJobs(
      first,
      await loadSeenServiceJobKeys(store, "group-a"),
    )).toHaveLength(1);
  });

  it("formats up to 12 jobs per Flex carousel and five reply messages", () => {
    const jobs = Array.from({ length: 70 }, (_, index) => job(index + 1));
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: jobs.length, jobs },
      jobs,
    );
    expect(result.messages).toHaveLength(5);
    expect(result.displayedJobs).toHaveLength(60);
    for (const message of result.messages) {
      const contents = message.contents as { contents: unknown[] };
      expect(contents.contents.length).toBeLessThanOrEqual(12);
    }
  });

  it("returns a simple message when there are no unseen jobs", () => {
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 3, jobs: [job(1), job(2), job(3)] },
      [],
    );
    expect(result.messages).toEqual([{
      type: "text",
      text: "ไม่พบงาน Service ใหม่\nงานที่กำลังเปิดอยู่ 3 งาน",
    }]);
  });

  it("formats all active jobs without a new-job label", () => {
    const jobs = [job(1), job(2)];
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: jobs.length, jobs },
      jobs,
      "all",
    );
    expect(result.displayedJobs).toEqual(jobs);
    expect(result.messages[0]).toMatchObject({
      type: "flex",
      altText: "งาน Service ทั้งหมด 2 งาน",
    });
  });

  it("reports when there are no active jobs in all mode", () => {
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 0, jobs: [] },
      [],
      "all",
    );
    expect(result.messages).toEqual([{
      type: "text",
      text: "ไม่พบงาน Service ที่กำลังเปิดอยู่",
    }]);
  });
});
