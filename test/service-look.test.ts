import { describe, expect, it, vi } from "vitest";
import {
  fetchCastleServiceSnapshot,
  formatCastleServiceReplies,
  type CastleServiceJob,
} from "../src/service-look";

function job(index: number): CastleServiceJob {
  return {
    jobNumber: `JOB-${index}`,
    terminalId: `TID-${index}`,
    merchantName: `Merchant ${index}`,
    province: "ชลบุรี",
    district: "เมือง",
    status: "OPEN",
    slaDate: "17/07/2569 12:00",
  };
}

describe("Service-look", () => {
  it("reads all current jobs from the Castle RPC service binding", async () => {
    const getCurrentJobs = vi.fn().mockResolvedValue({
      checkedAt: "2026-07-17T03:00:00.000Z",
      totalJobs: 2,
      jobs: [job(1), job(2)],
    });

    const snapshot = await fetchCastleServiceSnapshot(
      { getCurrentJobs },
    );

    expect(getCurrentJobs).toHaveBeenCalledOnce();
    expect(snapshot.totalJobs).toBe(2);
    expect(snapshot.jobs.map((item) => item.jobNumber)).toEqual(["JOB-1", "JOB-2"]);
  });

  it("formats the count, latest check time, and every returned job", () => {
    const replies = formatCastleServiceReplies({
      checkedAt: "2026-07-17T03:00:00.000Z",
      totalJobs: 2,
      jobs: [job(1), job(2)],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("งาน Service ปัจจุบัน 2 ตัว");
    expect(replies[0]).toContain("JOB-1");
    expect(replies[0]).toContain("JOB-2");
  });

  it("includes 300 jobs within LINE's five-message reply limit", () => {
    const jobs = Array.from({ length: 300 }, (_, index) => ({
      ...job(index + 1),
      merchantName: `Merchant ${index + 1} ${"x".repeat(40)}`,
    }));
    const replies = formatCastleServiceReplies({
      checkedAt: "2026-07-17T03:00:00.000Z",
      totalJobs: jobs.length,
      jobs,
    });

    expect(replies.length).toBeLessThanOrEqual(5);
    expect(replies.every((message) => message.length <= 4_900)).toBe(true);
    expect(replies.join("\n")).toContain("JOB-300");
  });
});
