const MAX_LINE_TEXT_LENGTH = 4_900;
const MAX_REPLY_MESSAGES = 5;

export interface CastleServiceJob {
  jobNumber: string;
  terminalId: string;
  merchantName: string;
  province: string;
  district: string;
  status: string;
  slaDate: string;
}

export interface CastleServiceSnapshot {
  checkedAt: string;
  totalJobs: number;
  jobs: CastleServiceJob[];
}

interface CastleStatusResponse {
  checkedAt?: string;
  totalJobs?: number;
  jobs?: Partial<CastleServiceJob>[];
}

export interface CastleServiceBinding {
  getCurrentJobs(): Promise<CastleStatusResponse>;
}

function text(value: unknown, maxLength = 120): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeJob(value: Partial<CastleServiceJob>): CastleServiceJob {
  return {
    jobNumber: text(value.jobNumber),
    terminalId: text(value.terminalId),
    merchantName: text(value.merchantName),
    province: text(value.province),
    district: text(value.district),
    status: text(value.status),
    slaDate: text(value.slaDate),
  };
}

export async function fetchCastleServiceSnapshot(
  service: CastleServiceBinding,
): Promise<CastleServiceSnapshot> {
  const data = await service.getCurrentJobs();
  if (!data || !Array.isArray(data.jobs)) {
    throw new Error("Castle service returned an invalid status payload");
  }

  const jobs = data.jobs.map(normalizeJob);
  const reportedTotal = Number(data.totalJobs);
  return {
    checkedAt: text(data.checkedAt, 80),
    totalJobs: Number.isFinite(reportedTotal) && reportedTotal >= 0
      ? Math.floor(reportedTotal)
      : jobs.length,
    jobs,
  };
}

function bangkokTime(value: string): string {
  if (!value) return "ไม่ระบุ";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour12: false,
  });
}

function jobBlock(job: CastleServiceJob, index: number): string {
  const id = job.jobNumber || job.terminalId || "-";
  const merchant = text(job.merchantName || "ไม่ระบุร้าน", 32);
  const area = text(job.district || job.province || "-", 18);
  const status = text(job.status || "-", 14);
  return `${index + 1}. ${id} | ${merchant} | ${area} | ${status}`;
}

export function formatCastleServiceReplies(
  snapshot: CastleServiceSnapshot,
): string[] {
  const header = [
    "Service-look",
    `งาน Service ปัจจุบัน ${snapshot.totalJobs} ตัว`,
    `ตรวจล่าสุด ${bangkokTime(snapshot.checkedAt)}`,
  ].join("\n");
  if (snapshot.jobs.length === 0) return [`${header}\n\nไม่พบงาน Service`];

  const messages = [header];
  let displayed = 0;
  for (const [index, job] of snapshot.jobs.entries()) {
    const block = jobBlock(job, index);
    const currentIndex = messages.length - 1;
    const candidate = `${messages[currentIndex]}\n${block}`;
    if (candidate.length <= MAX_LINE_TEXT_LENGTH) {
      messages[currentIndex] = candidate;
      displayed += 1;
      continue;
    }
    if (messages.length >= MAX_REPLY_MESSAGES) break;
    messages.push(`Service-look (ต่อ)\n${block}`);
    displayed += 1;
  }

  if (displayed < snapshot.jobs.length) {
    const note = `\n\nแสดง ${displayed} จาก ${snapshot.jobs.length} งาน เนื่องจากข้อความ LINE เต็ม`;
    const lastIndex = messages.length - 1;
    messages[lastIndex] = `${messages[lastIndex].slice(
      0,
      MAX_LINE_TEXT_LENGTH - note.length,
    )}${note}`;
  }
  return messages;
}
