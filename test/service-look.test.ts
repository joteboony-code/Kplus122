import { describe, expect, it, vi } from "vitest";
import {
  fetchCastleServiceSnapshot,
  formatServiceLookMessages,
  loadTechnicianNotifiedServiceJobKeys,
  loadSeenServiceJobKeys,
  saveTechnicianNotifiedServiceJobs,
  saveSeenServiceJobs,
  selectNewServiceJobs,
  selectUnnotifiedServiceJobsForTechnician,
  serviceAreaMentionMatchesJob,
  type CastleServiceJob,
} from "../src/service-look";
import type { StateStore } from "../src/state-store";
import type { ServiceAreaMention } from "../src/service-technicians";

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

function areaMention(
  overrides: Partial<ServiceAreaMention> = {},
): ServiceAreaMention {
  return {
    id: 1,
    technicianName: "ช่างโจ",
    lineUserId: "U285cef534729ee5bcfa1bf4d8e84e323",
    province: "ชลบุรี",
    district: "พานทอง",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
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

  it("tracks Service alerts separately for each technician", async () => {
    const store = memoryStore();
    const first = job(1);
    await saveTechnicianNotifiedServiceJobs(
      store,
      areaMention().lineUserId,
      new Set(),
      [first],
    );

    expect(await loadTechnicianNotifiedServiceJobKeys(
      store,
      areaMention().lineUserId,
    )).toEqual(new Set(["SERV-1"]));
    expect(await loadTechnicianNotifiedServiceJobKeys(
      store,
      "U11111111111111111111111111111111",
    )).toEqual(new Set());
  });

  it("selects only unnotified jobs in the image sender's assigned area", () => {
    const phanThongJob = {
      ...job(1),
      district: "พานทอง",
    };
    const sriRachaJob = {
      ...job(2),
      district: "ศรีราชา",
    };
    const snapshot = {
      checkedAt: "",
      totalJobs: 2,
      jobs: [phanThongJob, sriRachaJob],
    };
    const mentions = [
      areaMention(),
      areaMention({
        id: 2,
        lineUserId: "U11111111111111111111111111111111",
        district: "ศรีราชา",
      }),
    ];

    expect(selectUnnotifiedServiceJobsForTechnician(
      snapshot,
      mentions,
      areaMention().lineUserId,
      new Set(),
    )).toEqual([phanThongJob]);
    expect(selectUnnotifiedServiceJobsForTechnician(
      snapshot,
      mentions,
      areaMention().lineUserId,
      new Set(["SERV-1"]),
    )).toEqual([]);
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

  it("uses compact micro bubbles for Service jobs", () => {
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 1, jobs: [job(1)] },
      [job(1)],
    );
    const message = result.messages[0] as {
      contents: { contents: Array<Record<string, unknown>> };
    };
    expect(message.contents.contents[0]).toMatchObject({
      type: "bubble",
      size: "micro",
      body: { paddingAll: "12px" },
      footer: {
        paddingAll: "8px",
        paddingTop: "0px",
        contents: [{ type: "button", height: "sm" }],
      },
    });
  });

  it("mentions the assigned technician once for Phan Thong, Chonburi jobs", () => {
    const phanThongJob = {
      ...job(1),
      district: "อ.พานทอง",
      province: "จ.ชลบุรี",
    };
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 2, jobs: [phanThongJob, job(2)] },
      [job(2), phanThongJob],
      "new",
      [areaMention()],
    );

    expect(result.displayedJobs[0]).toEqual(phanThongJob);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      type: "textV2",
      text: "{technician0} มีงาน Service 1 งาน\nพื้นที่ พานทอง / ชลบุรี",
      substitution: {
        technician0: {
          type: "mention",
          mentionee: {
            type: "user",
            userId: "U285cef534729ee5bcfa1bf4d8e84e323",
          },
        },
      },
    });
    expect(result.messages[1]).toMatchObject({ type: "flex" });
  });

  it("does not mention the technician for jobs outside Phan Thong, Chonburi", () => {
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 1, jobs: [job(1)] },
      [job(1)],
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "flex" });
  });

  it("mentions a technician assigned to every district in the matching province", () => {
    const rayongJob = {
      ...job(1),
      province: "จ.ระยอง",
      district: "อ.เมืองระยอง",
    };
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 1, jobs: [rayongJob] },
      [rayongJob],
      "new",
      [areaMention({ province: "ระยอง", district: "ทุกอำเภอ" })],
    );

    expect(serviceAreaMentionMatchesJob(
      areaMention({ province: "ระยอง", district: "ทุกอำเภอ" }),
      rayongJob,
    )).toBe(true);

    expect(result.messages[0]).toMatchObject({
      type: "textV2",
      substitution: {
        technician0: {
          mentionee: { userId: "U285cef534729ee5bcfa1bf4d8e84e323" },
        },
      },
    });
  });

  it("does not apply an every-district assignment to another province", () => {
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: 1, jobs: [job(1)] },
      [job(1)],
      "new",
      [areaMention({ province: "ระยอง", district: "ทุกอำเภอ" })],
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: "flex" });
  });

  it("keeps the mention and Flex carousels within the five-message Reply limit", () => {
    const jobs = Array.from({ length: 60 }, (_, index) => ({
      ...job(index + 1),
      district: "พานทอง",
      province: "ชลบุรี",
    }));
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: jobs.length, jobs },
      jobs,
      "new",
      [areaMention()],
    );
    expect(result.messages).toHaveLength(5);
    expect(result.displayedJobs).toHaveLength(48);
    expect(result.messages[0]).toMatchObject({ type: "textV2" });
  });

  it("reserves one Reply slot for the receipt result in technician alerts", () => {
    const jobs = Array.from({ length: 60 }, (_, index) => ({
      ...job(index + 1),
      district: "พานทอง",
      province: "ชลบุรี",
    }));
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: jobs.length, jobs },
      jobs,
      "new",
      [areaMention()],
      4,
    );
    expect(result.messages).toHaveLength(4);
    expect(result.displayedJobs).toHaveLength(36);
  });

  it("mentions each technician only for jobs in their own area", () => {
    const jobs = [{
      ...job(1),
      district: "อ.พานทอง",
      province: "จ.ชลบุรี",
    }, {
      ...job(2),
      district: "ศรีราชา",
      province: "ชลบุรี",
    }];
    const result = formatServiceLookMessages(
      { checkedAt: "", totalJobs: jobs.length, jobs },
      jobs,
      "new",
      [
        areaMention(),
        areaMention({
          id: 2,
          technicianName: "ช่างสอง",
          lineUserId: "U11111111111111111111111111111111",
          district: "ศรีราชา",
        }),
      ],
    );
    expect(result.messages[0]).toMatchObject({
      type: "textV2",
      substitution: {
        technician0: { mentionee: { userId: areaMention().lineUserId } },
        technician1: { mentionee: { userId: "U11111111111111111111111111111111" } },
      },
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
