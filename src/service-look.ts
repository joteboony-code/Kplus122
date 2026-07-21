import type { StateStore } from "./state-store";
import type { ServiceAreaMention } from "./service-technicians";

const MAX_BUBBLES_PER_CAROUSEL = 12;
const MAX_REPLY_MESSAGES = 5;
const MAX_MENTIONS_PER_MESSAGE = 20;
const SEEN_STATE_PREFIX = "service-look:seen:";
const TECHNICIAN_NOTIFIED_STATE_PREFIX = "service-alert:notified:";

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

function technicianNotifiedStateKey(lineUserId: string): string {
  return `${TECHNICIAN_NOTIFIED_STATE_PREFIX}${lineUserId}`;
}

export async function loadTechnicianNotifiedServiceJobKeys(
  store: StateStore,
  lineUserId: string,
): Promise<Set<string>> {
  const raw = await store.get(technicianNotifiedStateKey(lineUserId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((value) => cleanText(value, 300)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function selectUnnotifiedServiceJobsForTechnician(
  snapshot: CastleServiceSnapshot,
  mentions: ServiceAreaMention[],
  lineUserId: string,
  notified: ReadonlySet<string>,
): CastleServiceJob[] {
  const technicianMentions = mentions.filter((mention) =>
    mention.enabled && mention.lineUserId === lineUserId
  );
  if (technicianMentions.length === 0) return [];
  return snapshot.jobs.filter((job) => {
    const key = serviceJobKey(job);
    return Boolean(
      key &&
      !notified.has(key) &&
      technicianMentions.some((mention) =>
        serviceAreaMentionMatchesJob(mention, job)
      ),
    );
  });
}

export async function saveTechnicianNotifiedServiceJobs(
  store: StateStore,
  lineUserId: string,
  previousNotified: ReadonlySet<string>,
  notifiedJobs: CastleServiceJob[],
): Promise<void> {
  const nextNotified = new Set(previousNotified);
  for (const job of notifiedJobs) {
    const key = serviceJobKey(job);
    if (key) nextNotified.add(key);
  }
  await store.put(
    technicianNotifiedStateKey(lineUserId),
    JSON.stringify([...nextNotified]),
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizedArea(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("th-TH")
    .replace(/จังหวัด|อำเภอ/g, "")
    .replace(/(^|\s)(จ|อ)\.?\s*/g, "$1")
    .replace(/[\s._\-/]/g, "");
}

function areaMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizedArea(left);
  const normalizedRight = normalizedArea(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)),
  );
}

function districtMatches(assignedDistrict: string, jobDistrict: string): boolean {
  const wildcard = assignedDistrict.normalize("NFKC").toLocaleLowerCase("th-TH")
    .replace(/\s+/g, "");
  const wildcardLabels = ["*", "ทุกอำเภอ", "ทุกเขต", "ทั้งหมด"]
    .map((value) => value.normalize("NFKC").toLocaleLowerCase("th-TH"));
  if (wildcardLabels.includes(wildcard)) {
    return true;
  }
  return areaMatches(assignedDistrict, jobDistrict);
}

export function serviceAreaMentionMatchesJob(
  mention: ServiceAreaMention,
  job: CastleServiceJob,
): boolean {
  return mention.enabled &&
    areaMatches(mention.province, job.province) &&
    districtMatches(mention.district, job.district);
}

function jobHasMention(
  job: CastleServiceJob,
  mentions: ServiceAreaMention[],
): boolean {
  return mentions.some((mention) => serviceAreaMentionMatchesJob(mention, job));
}

function technicianMentionMessage(
  jobs: CastleServiceJob[],
  mentions: ServiceAreaMention[],
): Record<string, unknown> | null {
  const assignments = new Map<
    string,
    { jobs: Set<string>; areas: Set<string> }
  >();
  for (const job of jobs) {
    for (const mention of mentions) {
      if (!serviceAreaMentionMatchesJob(mention, job)) continue;
      const current = assignments.get(mention.lineUserId) ?? {
        jobs: new Set<string>(),
        areas: new Set<string>(),
      };
      current.jobs.add(serviceJobKey(job));
      current.areas.add(`${mention.district} / ${mention.province}`);
      assignments.set(mention.lineUserId, current);
    }
  }

  const selected = [...assignments.entries()].slice(0, MAX_MENTIONS_PER_MESSAGE);
  if (selected.length === 0) return null;
  const substitution: Record<string, unknown> = {};
  const lines = selected.map(([lineUserId, summary], index) => {
    const key = `technician${index}`;
    substitution[key] = {
      type: "mention",
      mentionee: { type: "user", userId: lineUserId },
    };
    const areas = [...summary.areas].slice(0, 3).join(", ");
    return `{${key}} มีงาน Service ${summary.jobs.size} งาน\nพื้นที่ ${areas}`;
  });
  return {
    type: "textV2",
    text: lines.join("\n\n"),
    substitution,
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
  areaMentions: ServiceAreaMention[] = [],
  maxMessages = MAX_REPLY_MESSAGES,
): ServiceLookMessages {
  const boundedMaxMessages = Math.max(1, Math.min(MAX_REPLY_MESSAGES, maxMessages));
  const assignedJobs = newJobs.filter((job) => jobHasMention(job, areaMentions));
  const orderedJobs = assignedJobs.length > 0
    ? [...assignedJobs, ...newJobs.filter((job) => !jobHasMention(job, areaMentions))]
    : newJobs;
  const flexMessageLimit = assignedJobs.length > 0
    ? Math.max(0, boundedMaxMessages - 1)
    : boundedMaxMessages;
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
  const mentionMessage = technicianMentionMessage(displayedJobs, areaMentions);
  if (mentionMessage) messages.push(mentionMessage);
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
