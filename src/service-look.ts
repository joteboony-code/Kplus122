import type { StateStore } from "./state-store";

const MAX_BUBBLES_PER_CAROUSEL = 12;
const MAX_REPLY_MESSAGES = 5;
const SEEN_STATE_PREFIX = "service-look:seen:";
const PHAN_THONG_TECHNICIAN_USER_ID = "U285cef534729ee5bcfa1bf4d8e84e323";

export interface CastleServiceJob {
  jobNumber: string;
  terminalId: string;
  merchantName: string;
  province: string;
  district: string;
  status: string;
  slaDate: string;
  link: string;
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

export interface ServiceLookMessages {
  messages: Record<string, unknown>[];
  displayedJobs: CastleServiceJob[];
}

function cleanText(value: unknown, maxLength = 160): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeJob(value: Partial<CastleServiceJob>): CastleServiceJob {
  return {
    jobNumber: cleanText(value.jobNumber, 80),
    terminalId: cleanText(value.terminalId, 80),
    merchantName: cleanText(value.merchantName),
    province: cleanText(value.province, 80),
    district: cleanText(value.district, 80),
    status: cleanText(value.status, 80),
    slaDate: cleanText(value.slaDate, 100),
    link: cleanText(value.link, 2_000),
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
    checkedAt: cleanText(data.checkedAt, 80),
    totalJobs: Number.isFinite(reportedTotal) && reportedTotal >= 0
      ? Math.floor(reportedTotal)
      : jobs.length,
    jobs,
  };
}

export function serviceJobKey(job: CastleServiceJob): string {
  return cleanText(
    job.jobNumber || `${job.terminalId}|${job.merchantName}|${job.slaDate}`,
    300,
  );
}

function seenStateKey(conversationId: string): string {
  return `${SEEN_STATE_PREFIX}${conversationId}`;
}

export async function loadSeenServiceJobKeys(
  store: StateStore,
  conversationId: string,
): Promise<Set<string>> {
  const raw = await store.get(seenStateKey(conversationId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((value) => cleanText(value, 300)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function selectNewServiceJobs(
  snapshot: CastleServiceSnapshot,
  seen: ReadonlySet<string>,
): CastleServiceJob[] {
  return snapshot.jobs.filter((job) => {
    const key = serviceJobKey(job);
    return key && !seen.has(key);
  });
}

export async function saveSeenServiceJobs(
  store: StateStore,
  conversationId: string,
  snapshot: CastleServiceSnapshot,
  previousSeen: ReadonlySet<string>,
  displayedJobs: CastleServiceJob[],
): Promise<void> {
  const activeKeys = new Set(snapshot.jobs.map(serviceJobKey).filter(Boolean));
  const nextSeen = new Set(
    [...previousSeen].filter((key) => activeKeys.has(key)),
  );
  for (const job of displayedJobs) nextSeen.add(serviceJobKey(job));
  await store.put(seenStateKey(conversationId), JSON.stringify([...nextSeen]));
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPhanThongChonburiJob(job: CastleServiceJob): boolean {
  return job.district.includes("พานทอง") && job.province.includes("ชลบุรี");
}

function phanThongMentionMessage(jobCount: number): Record<string, unknown> {
  return {
    type: "textV2",
    text: "{technician}\nมีงาน Service พื้นที่พานทอง / ชลบุรี " +
      `${jobCount} งาน`,
    substitution: {
      technician: {
        type: "mention",
        mentionee: {
          type: "user",
          userId: PHAN_THONG_TECHNICIAN_USER_ID,
        },
      },
    },
  };
}

function fieldRow(label: string, value: string): Record<string, unknown> {
  return {
    type: "box",
    layout: "baseline",
    spacing: "xs",
    contents: [
      { type: "text", text: label, color: "#8C8C8C", size: "xxs", flex: 2 },
      {
        type: "text",
        text: value || "-",
        color: "#333333",
        size: "xxs",
        flex: 5,
        wrap: true,
        maxLines: 2,
      },
    ],
  };
}

function jobBubble(job: CastleServiceJob): Record<string, unknown> {
  const area = [job.district, job.province].filter(Boolean).join(" / ") || "-";
  const body: Record<string, unknown>[] = [
    {
      type: "text",
      text: `งาน ${job.jobNumber || job.terminalId || "ไม่ระบุ"}`,
      weight: "bold",
      size: "sm",
      color: "#0A7A45",
      wrap: true,
      maxLines: 2,
    },
    {
      type: "text",
      text: job.merchantName || "ไม่ระบุร้าน",
      size: "xs",
      weight: "bold",
      margin: "sm",
      wrap: true,
      maxLines: 2,
    },
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        fieldRow("Terminal", job.terminalId),
        fieldRow("พื้นที่", area),
        fieldRow("สถานะ", job.status),
        fieldRow("SLA", job.slaDate),
      ],
    },
  ];

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "micro",
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: body,
    },
  };
  if (isHttpsUrl(job.link)) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "8px",
      paddingTop: "0px",
      contents: [{
        type: "button",
        style: "primary",
        height: "sm",
        color: "#08A65C",
        action: { type: "uri", label: "เปิดรายละเอียดงาน", uri: job.link },
      }],
    };
  }
  return bubble;
}

export function formatServiceLookMessages(
  snapshot: CastleServiceSnapshot,
  newJobs: CastleServiceJob[],
  mode: "new" | "all" = "new",
): ServiceLookMessages {
  const assignedJobs = newJobs.filter(isPhanThongChonburiJob);
  const orderedJobs = assignedJobs.length > 0
    ? [...assignedJobs, ...newJobs.filter((job) => !isPhanThongChonburiJob(job))]
    : newJobs;
  const flexMessageLimit = assignedJobs.length > 0
    ? MAX_REPLY_MESSAGES - 1
    : MAX_REPLY_MESSAGES;
  const displayedJobs = orderedJobs.slice(
    0,
    MAX_BUBBLES_PER_CAROUSEL * flexMessageLimit,
  );
  if (displayedJobs.length === 0) {
    return {
      displayedJobs,
      messages: [{
        type: "text",
        text: mode === "all"
          ? "ไม่พบงาน Service ที่กำลังเปิดอยู่"
          : `ไม่พบงาน Service ใหม่\nงานที่กำลังเปิดอยู่ ${snapshot.totalJobs} งาน`,
      }],
    };
  }

  const messages: Record<string, unknown>[] = [];
  const displayedAssignedJobs = displayedJobs.filter(isPhanThongChonburiJob);
  if (displayedAssignedJobs.length > 0) {
    messages.push(phanThongMentionMessage(displayedAssignedJobs.length));
  }
  for (let index = 0; index < displayedJobs.length; index += MAX_BUBBLES_PER_CAROUSEL) {
    const page = displayedJobs.slice(index, index + MAX_BUBBLES_PER_CAROUSEL);
    messages.push({
      type: "flex",
      altText: mode === "all"
        ? `งาน Service ทั้งหมด ${displayedJobs.length} งาน`
        : `พบงาน Service ใหม่ ${displayedJobs.length} งาน`,
      contents: {
        type: "carousel",
        contents: page.map(jobBubble),
      },
    });
  }
  return { messages, displayedJobs };
}
