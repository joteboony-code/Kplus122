import { getOcrSpaceUsage, OCR_SPACE_DAILY_LIMIT } from "./ocr-space-usage";
import {
  getGoogleVisionUsage,
  GOOGLE_VISION_FREE_MONTHLY_UNITS,
} from "./google-vision-usage";
import { getDailyStats, type DailyStats } from "./daily-stats";
import {
  clearInspectionLogs,
  listInspectionLogs,
  type InspectionLogRow,
} from "./audit-log";
import {
  deleteServiceAreaMention,
  getServiceAreaMention,
  listServiceAreaMentions,
  saveServiceAreaMention,
  type ServiceAreaMention,
  type ServiceAreaMentionInput,
} from "./service-technicians";

const PROCESSING_ENABLED_KEY = "control:processing-enabled";
const SESSION_COOKIE = "kplus_control_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const QUEUE_DAILY_FREE_LIMIT = 10_000;

function securityHeaders(contentType = "text/html; charset=utf-8"): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function htmlResponse(body: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { ...securityHeaders(), ...extraHeaders },
  });
}

function redirectTo(path: string, cookie?: string): Response {
  const headers = new Headers({
    Location: path,
    ...securityHeaders("text/plain; charset=utf-8"),
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response("Redirecting", { status: 303, headers });
}

function redirectToControl(cookie?: string): Response {
  return redirectTo("/control", cookie);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

async function signSession(expiresAt: number, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expiresAt))),
  );
  return `${expiresAt}.${bytesToBase64Url(signature)}`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return null;
}

async function hasValidSession(request: Request, password: string): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;

  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await signSession(expiresAt, password);
  return constantTimeEqual(token, expected);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  if (origin === new URL(request.url).origin) return true;

  // Some browser/privacy combinations serialize an opaque form origin as
  // "null". Sec-Fetch-Site is still emitted by the browser and lets us accept
  // the real same-origin form without allowing cross-site POST requests.
  return origin === "null" && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export async function isProcessingEnabled(
  db: D1Database,
  forceDisabled = false,
): Promise<boolean> {
  if (forceDisabled) return false;
  const row = await db
    .prepare("SELECT value FROM control_state WHERE key = ?")
    .bind(PROCESSING_ENABLED_KEY)
    .first<{ value: string }>();
  return row?.value !== "false";
}

export async function setProcessingEnabled(
  db: D1Database,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(`INSERT INTO control_state (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at`)
    .bind(PROCESSING_ENABLED_KEY, String(enabled))
    .run();
}

function loginPage(error = ""): string {
  const errorBlock = error
    ? `<div class="alert" role="alert">${error}</div>`
    : "";
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KPLUS Control</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Noto Sans Thai",system-ui,sans-serif;background:#08110d;color:#eefbf4}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,#173d2a 0,transparent 48%),#08110d}
    .card{width:min(100%,430px);padding:30px;border:1px solid #2c4b3a;border-radius:24px;background:rgba(13,29,21,.94);box-shadow:0 24px 80px #0008}
    .mark{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;background:#25d366;color:#07110c;font-size:25px;font-weight:900;margin-bottom:24px}
    h1{font-size:28px;margin:0 0 8px}p{margin:0 0 24px;color:#a8c3b4;line-height:1.65}
    label{display:block;margin-bottom:9px;font-weight:700}.field{width:100%;padding:15px 16px;border-radius:13px;border:1px solid #3a5b49;background:#09140e;color:#fff;font-size:18px;outline:none}.field:focus{border-color:#25d366;box-shadow:0 0 0 3px #25d36622}
    button{width:100%;margin-top:16px;padding:15px;border:0;border-radius:13px;background:#25d366;color:#07110c;font-size:17px;font-weight:900;cursor:pointer}button:hover{background:#46e17e}
    .alert{margin:0 0 18px;padding:12px 14px;border-radius:11px;background:#4b1e25;color:#ffbdc6;border:1px solid #863746}
    .foot{margin-top:20px;text-align:center;color:#6f8c7c;font-size:13px}
  </style>
</head>
<body><main class="card"><div class="mark">K+</div><h1>ศูนย์ควบคุม KPLUS</h1><p>เข้าสู่ระบบเพื่อเปิดหรือหยุดการตรวจรูปจากกลุ่ม LINE</p>${errorBlock}
  <form method="post" action="/control/login"><label for="password">รหัสผ่าน</label><input class="field" id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">เข้าสู่ระบบ</button></form>
  <div class="foot">เซสชันหมดอายุอัตโนมัติภายใน 8 ชั่วโมง</div></main></body></html>`;
}

function confirmPage(target: "disable" | "clear-logs"): string {
  const disable = target === "disable";
  const title = disable ? "ยืนยันหยุดระบบ" : "ยืนยันล้าง Log";
  const detail = disable
    ? "รูปใหม่จะไม่ถูกตรวจจนกว่าจะเปิดระบบอีกครั้ง"
    : "Log การตรวจทั้งหมดจะถูกลบและไม่สามารถกู้คืนได้";
  const action = disable ? "/control/toggle" : "/control/logs/clear";
  const hidden = disable
    ? '<input type="hidden" name="action" value="disable">'
    : "";
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    :root{color-scheme:dark;font-family:Inter,"Noto Sans Thai",system-ui,sans-serif;background:#08110d;color:#eefbf4}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#08110d}.confirm{width:min(100%,430px);padding:28px;border:1px solid #663b41;border-radius:20px;background:#211317;box-shadow:0 24px 80px #0008}h1{margin:0 0 10px;font-size:26px}p{margin:0 0 22px;color:#d5aab1;line-height:1.6}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.actions button,.actions a{display:grid;place-items:center;min-height:48px;border-radius:12px;font-weight:900;text-decoration:none}.actions button{border:0;background:#f06474;color:#2b090e;cursor:pointer}.actions a{border:1px solid #3a5b49;color:#c8ded2;background:#0b1710}
  </style></head><body><main class="confirm"><h1>${title}</h1><p>${detail}</p><div class="actions"><a href="/control">ยกเลิก</a><form method="post" action="${action}">${hidden}<button type="submit">ยืนยัน</button></form></div></main></body></html>`;
}

interface ProviderStatus {
  paddleOcrConfigured: boolean;
  ocrSpaceConfigured: boolean;
  ocrSpaceUsage: number;
  googleVisionConfigured: boolean;
  googleVisionUsage: number;
  dailyStats: DailyStats;
  logs: InspectionLogRow[];
  versionId: string;
  versionTimestamp: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface OcrProviderBadge {
  key: string;
  label: string;
  icon: string;
  milliseconds: number;
}

function ocrProviderBadges(log: InspectionLogRow): OcrProviderBadge[] {
  const timings: Record<string, number> = {};
  if (log.provider_timings) {
    try {
      Object.assign(timings, JSON.parse(log.provider_timings) as Record<string, number>);
    } catch {
      // Keep rendering the provider list even if an old log has malformed timing JSON.
    }
  }

  const badges = new Map<string, OcrProviderBadge>();
  for (const rawName of (log.provider_chain ?? "").split(">")) {
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const provider = name.includes("paddleocr")
      ? { key: "paddleocr", label: "PaddleOCR", icon: "P" }
      : name === "ocr-space"
        ? { key: "ocr-space", label: "OCR.space", icon: "O" }
        : name.startsWith("workers-ai")
          ? { key: "workers-ai", label: "Workers AI", icon: "W" }
          : name === "google-vision"
            ? { key: "google-vision", label: "Google Vision", icon: "G" }
            : null;
    if (!provider || badges.has(provider.key)) continue;
    const milliseconds = Object.entries(timings)
      .filter(([timingName]) => {
        if (provider.key === "paddleocr") return timingName.includes("paddleocr");
        if (provider.key === "workers-ai") return timingName.startsWith("workers-ai");
        return timingName === provider.key;
      })
      .reduce((total, [, value]) => total + (Number.isFinite(value) ? value : 0), 0);
    badges.set(provider.key, { ...provider, milliseconds });
  }
  return [...badges.values()];
}

function formatProviderTime(milliseconds: number): string {
  return milliseconds > 0 ? ` · ${(milliseconds / 1000).toFixed(2)}s` : "";
}

function technicianForm(
  mention?: ServiceAreaMention,
  draft?: Partial<ServiceAreaMentionInput>,
): string {
  const value = {
    technicianName: draft?.technicianName ?? mention?.technicianName ?? "",
    lineUserId: draft?.lineUserId ?? mention?.lineUserId ?? "",
    province: draft?.province ?? mention?.province ?? "",
    district: draft?.district ?? mention?.district ?? "",
    enabled: draft?.enabled ?? mention?.enabled ?? true,
  };
  const idInput = mention
    ? `<input type="hidden" name="id" value="${mention.id}">`
    : "";
  return `<form class="technician-form" method="post" action="/control/technicians/save">
    ${idInput}
    <label><span>ชื่อช่าง</span><input name="technicianName" value="${escapeHtml(value.technicianName)}" maxlength="100" required placeholder="เช่น ช่างโจ"></label>
    <label><span>LINE User ID</span><input name="lineUserId" value="${escapeHtml(value.lineUserId)}" maxlength="64" required placeholder="Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></label>
    <label><span>จังหวัด</span><input name="province" value="${escapeHtml(value.province)}" maxlength="80" required placeholder="ชลบุรี"></label>
    <label><span>อำเภอ</span><input name="district" value="${escapeHtml(value.district)}" maxlength="80" required placeholder="พานทอง หรือ ทุกอำเภอ"></label>
    <label class="enabled"><input type="checkbox" name="enabled" value="true"${value.enabled ? " checked" : ""}><span>เปิดใช้งานการแท็ก</span></label>
    <div class="form-actions"><button class="save" type="submit">${mention ? "บันทึกการแก้ไข" : "เพิ่มช่างและพื้นที่"}</button>${mention ? `<a class="delete" href="/control/technicians/delete?id=${mention.id}">ลบ</a>` : ""}</div>
  </form>`;
}

function techniciansPage(
  mentions: ServiceAreaMention[],
  error = "",
  draft?: Partial<ServiceAreaMentionInput>,
): string {
  const rows = mentions.length === 0
    ? '<div class="empty">ยังไม่มีข้อมูลช่างและพื้นที่รับผิดชอบ</div>'
    : mentions.map((mention) => `<details class="technician-card"${mentions.length === 1 ? " open" : ""}>
        <summary><span><b>${escapeHtml(mention.technicianName)}</b><small>${escapeHtml(mention.district)} / ${escapeHtml(mention.province)}</small></span><i class="${mention.enabled ? "on" : "off"}">${mention.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}</i></summary>
        ${technicianForm(mention)}
      </details>`).join("");
  const errorBlock = error
    ? `<div class="alert" role="alert">${escapeHtml(error)}</div>`
    : "";
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>จัดการช่างและพื้นที่ · KPLUS Control</title><style>
    :root{color-scheme:dark;font-family:Inter,"Noto Sans Thai",system-ui,sans-serif;background:#07100c;color:#f1fff7}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:20px;background:radial-gradient(circle at 15% 0,#163e29 0,transparent 36%),#07100c}.shell{width:min(100%,820px);margin:20px auto}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.top a{color:#9ff3bd;text-decoration:none;font-weight:800}.top h1{margin:0;font-size:clamp(24px,5vw,34px)}.intro{margin:0 0 22px;color:#91aa9c;line-height:1.6}.panel{padding:22px;border:1px solid #2f7350;border-radius:22px;background:#0d1c15;box-shadow:0 24px 70px #0006}.panel h2{margin:0 0 15px;font-size:18px}.alert{margin-bottom:16px;padding:12px 14px;border:1px solid #9d4350;border-radius:11px;background:#421a21;color:#ffb4bf}.technician-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.technician-form label>span{display:block;margin-bottom:6px;color:#9ab2a5;font-size:12px;font-weight:800}.technician-form input:not([type=checkbox]){width:100%;padding:11px 12px;border:1px solid #355343;border-radius:10px;background:#08120d;color:#fff;font-size:14px;outline:none}.technician-form input:focus{border-color:#32dc79;box-shadow:0 0 0 3px #32dc7922}.enabled{grid-column:1/-1;display:flex;align-items:center;gap:9px;padding:4px 0}.enabled input{width:18px;height:18px;accent-color:#2ed875}.enabled span{margin:0!important}.form-actions{grid-column:1/-1;display:flex;gap:9px}.form-actions button,.form-actions a{display:grid;place-items:center;min-height:43px;border-radius:10px;font-weight:900;text-decoration:none}.save{flex:1;border:0;background:#2ed875;color:#06110b;cursor:pointer}.delete{width:76px;border:1px solid #713844;color:#ff9daa;background:#241317}.list{display:grid;gap:10px;margin-top:20px}.technician-card{border:1px solid #294537;border-radius:14px;background:#0a1710;overflow:hidden}.technician-card summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;cursor:pointer;list-style:none}.technician-card summary::-webkit-details-marker{display:none}.technician-card summary span{min-width:0}.technician-card summary b,.technician-card summary small{display:block}.technician-card summary small{margin-top:4px;color:#829e8f}.technician-card summary i{padding:5px 8px;border-radius:999px;font-size:11px;font-style:normal;font-weight:900;white-space:nowrap}.technician-card summary i.on{border:1px solid #2ed875;color:#72efa1;background:#113720}.technician-card summary i.off{border:1px solid #5c7165;color:#9aafa3;background:#152019}.technician-card .technician-form{padding:14px;border-top:1px solid #294537}.empty{padding:20px;text-align:center;color:#829e8f;border:1px dashed #355343;border-radius:13px}@media(max-width:620px){body{padding:13px}.shell{margin:8px auto}.panel{padding:17px}.technician-form{grid-template-columns:1fr}.enabled,.form-actions{grid-column:1}.top{align-items:flex-start;flex-direction:column}}
  </style></head><body><main class="shell"><header class="top"><div><a href="/control">← กลับหน้าควบคุม</a><h1>ช่างและพื้นที่รับผิดชอบ</h1></div></header><p class="intro">ระบบจะแท็กช่างอัตโนมัติเมื่อพบงาน Service ที่ตรงทั้งอำเภอและจังหวัด สามารถเพิ่มพื้นที่ซ้ำให้ช่างคนเดิมได้</p>${errorBlock}<section class="panel"><h2>เพิ่มรายการใหม่</h2>${technicianForm(undefined, draft)}</section><section class="list">${rows}</section></main></body></html>`;
}

function technicianDeletePage(mention: ServiceAreaMention): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ยืนยันลบข้อมูลช่าง</title><style>
    :root{color-scheme:dark;font-family:Inter,"Noto Sans Thai",system-ui,sans-serif;background:#08110d;color:#eefbf4}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#08110d}.confirm{width:min(100%,440px);padding:28px;border:1px solid #663b41;border-radius:20px;background:#211317;box-shadow:0 24px 80px #0008}h1{margin:0 0 10px;font-size:25px}p{margin:0 0 22px;color:#d5aab1;line-height:1.6}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.actions button,.actions a{display:grid;place-items:center;min-height:48px;border-radius:12px;font-weight:900;text-decoration:none}.actions button{border:0;background:#f06474;color:#2b090e;cursor:pointer}.actions a{border:1px solid #3a5b49;color:#c8ded2;background:#0b1710}
  </style></head><body><main class="confirm"><h1>ยืนยันลบข้อมูลช่าง</h1><p>${escapeHtml(mention.technicianName)} · ${escapeHtml(mention.district)} / ${escapeHtml(mention.province)} จะไม่ถูกแท็กสำหรับพื้นที่นี้อีก</p><div class="actions"><a href="/control/technicians">ยกเลิก</a><form method="post" action="/control/technicians/delete"><input type="hidden" name="id" value="${mention.id}"><button type="submit">ยืนยันลบ</button></form></div></main></body></html>`;
}

function mentionInputFromForm(form: FormData): ServiceAreaMentionInput {
  return {
    technicianName: String(form.get("technicianName") ?? ""),
    lineUserId: String(form.get("lineUserId") ?? ""),
    province: String(form.get("province") ?? ""),
    district: String(form.get("district") ?? ""),
    enabled: form.get("enabled") === "true",
  };
}

function friendlyMentionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "บันทึกข้อมูลไม่สำเร็จ";
  return /unique|constraint/i.test(message)
    ? "ช่างคนนี้มีพื้นที่จังหวัดและอำเภอนี้อยู่แล้ว"
    : message;
}

function bangkokTime(value: Date): string {
  return value.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour12: false,
  });
}

function serviceAlerts(enabled: boolean, providers: ProviderStatus): string {
  const alerts: string[] = [];
  if (!enabled) alerts.push("ระบบตรวจรูปกำลังหยุดทำงาน");
  if (!providers.paddleOcrConfigured) alerts.push("PaddleOCR ยังไม่ได้ตั้งค่า access token");
  if (!providers.ocrSpaceConfigured) alerts.push("OCR.space ยังไม่ได้ตั้งค่า API key");
  if (providers.ocrSpaceUsage >= OCR_SPACE_DAILY_LIMIT) {
    alerts.push("OCR.space ครบโควตาวันนี้ ระบบจะใช้ Workers AI แทน");
  }
  if (!providers.googleVisionConfigured) alerts.push("Google Vision ยังไม่ได้ตั้งค่า API key");
  if (providers.googleVisionUsage >= GOOGLE_VISION_FREE_MONTHLY_UNITS) {
    alerts.push("Google Vision ถึงเพดานการใช้งานประจำเดือน");
  }
  if (providers.dailyStats.ocrSpaceErrors > 0) {
    alerts.push(`OCR.space ผิดพลาดวันนี้ ${providers.dailyStats.ocrSpaceErrors} ครั้ง`);
  }
  if (providers.dailyStats.workersAiErrors > 0) {
    alerts.push(`Workers AI ผิดพลาดวันนี้ ${providers.dailyStats.workersAiErrors} ครั้ง`);
  }
  if (providers.dailyStats.googleVisionErrors > 0) {
    alerts.push(`Google Vision ผิดพลาดวันนี้ ${providers.dailyStats.googleVisionErrors} ครั้ง`);
  }
  if (providers.dailyStats.errors > 0) {
    alerts.push(`งานตรวจผิดพลาดวันนี้ ${providers.dailyStats.errors} รายการ`);
  }
  return alerts.length === 0
    ? '<div class="service-health ok">✓ บริการทั้งหมดทำงานปกติ</div>'
    : `<div class="service-health warning"><b>⚠ พบสิ่งที่ต้องตรวจสอบ</b><ul>${alerts.map((alert) => `<li>${escapeHtml(alert)}</li>`).join("")}</ul></div>`;
}

function logCards(logs: InspectionLogRow[]): string {
  if (logs.length === 0) {
    return '<div class="log-empty">ยังไม่มี Log การตรวจรูป</div>';
  }
  return logs.map((log) => {
    const time = new Date(log.created_at * 1000).toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
      hour12: false,
    });
    const outcomeLabel = log.outcome === "pass"
      ? "ผ่าน"
      : log.outcome === "fail"
        ? "ไม่ผ่าน"
        : log.outcome === "error"
          ? "ผิดพลาด"
          : "ข้าม/เงียบ";
    const outcomeIcon = log.outcome === "pass"
      ? "✓"
      : log.outcome === "fail"
        ? "✕"
        : log.outcome === "error"
          ? "!"
          : "−";
    const amounts = log.observed_amounts
      ? escapeHtml(log.observed_amounts.replaceAll(/[\[\]"]/g, ""))
      : "-";
    const kplusState = log.has_kplus === null
      ? { css: "unknown", text: "ยังไม่ทราบ" }
      : log.has_kplus
        ? { css: "found", text: "พบ KPLUS" }
        : { css: "missing", text: "ไม่พบ KPLUS" };
    const settlementState = log.has_settlement === null
      ? { css: "unknown", text: "ยังไม่ทราบ" }
      : log.has_settlement
        ? { css: "found", text: "พบ SETTLEMENT" }
        : { css: "missing", text: "ไม่พบ SETTLEMENT" };
    const deliveryState = log.line_delivery_status === "sent"
      ? {
          css: "sent",
          text: log.line_delivery_method === "push"
            ? "Push สำเร็จ"
            : "Reply สำเร็จ",
        }
      : log.line_delivery_status === "pending"
        ? { css: "pending", text: "รอส่ง Reply" }
        : log.line_delivery_status === "failed"
          ? { css: "failed", text: "ส่งไม่สำเร็จ" }
          : { css: "none", text: "ไม่ต้องส่ง" };
    let timing = "";
    if (log.provider_timings) {
      try {
        const parsed = JSON.parse(log.provider_timings) as Record<string, number>;
        timing = Object.entries(parsed)
          .map(([name, milliseconds]) => `${name} ${milliseconds}ms`)
          .join(" · ");
      } catch {
        timing = log.provider_timings;
      }
    }
    const providers = ocrProviderBadges(log);
    const providerBadges = providers.length > 0
      ? providers.map((provider) =>
          `<span class="evidence-chip provider" title="ใช้เวลา ${provider.milliseconds}ms"><i>${provider.icon}</i>${provider.label}${formatProviderTime(provider.milliseconds)}</span>`,
        ).join("")
      : '<span class="evidence-chip unknown"><i>?</i>ไม่พบข้อมูลระบบ OCR</span>';
    const usedPaddle = providers.some((provider) => provider.key === "paddleocr");
    const paddleResult = usedPaddle
      ? `<section class="paddle-result"><b>ผลข้อความจาก PaddleOCR</b>${
          log.paddle_ocr_text?.trim()
            ? `<pre>${escapeHtml(log.paddle_ocr_text)}</pre>`
            : '<p>รายการนี้ไม่มีข้อความ PaddleOCR ที่บันทึกไว้</p>'
        }</section>`
      : "";
    const evidence = log.evidence_json?.trim()
      ? `<details class="evidence-detail"><summary>หลักฐานแบบย่อ</summary><pre>${escapeHtml(log.evidence_json)}</pre></details>`
      : "";
    return `<article class="log-row ${escapeHtml(log.outcome)}">
      <div class="log-main">
        <b class="outcome-badge"><i>${outcomeIcon}</i>${outcomeLabel}</b>
        <span class="log-cell"><small>เลขงาน</small><strong class="job-value">${escapeHtml(log.reference_code ?? "ไม่ระบุ")}</strong></span>
        <span class="log-cell"><small>ยอดที่อ่านได้</small><strong class="amount-value">${amounts}</strong></span>
        <div class="evidence-row" aria-label="หลักฐานที่ตรวจพบ">
        <span class="evidence-chip ${kplusState.css}"><i>${kplusState.css === "found" ? "✓" : kplusState.css === "missing" ? "✕" : "?"}</i>${kplusState.text}</span>
        <span class="evidence-chip ${settlementState.css}"><i>${settlementState.css === "found" ? "✓" : settlementState.css === "missing" ? "✕" : "?"}</i>${settlementState.text}</span>
        ${providerBadges}
        </div>
        <span class="delivery-chip ${deliveryState.css}">${deliveryState.text}</span>
        <div class="log-meta"><time>${escapeHtml(time)}</time><span>${log.processing_ms}ms${log.queue_delay_ms === null ? "" : ` · รอคิว ${log.queue_delay_ms}ms`}</span></div>
      </div>
      <details class="log-more"><summary>รายละเอียด</summary><div>เส้นทาง: ${escapeHtml(log.provider_chain ?? "ไม่เรียก OCR")} · ขั้นตอน: ${escapeHtml(log.stage ?? "-")}${timing ? ` · ${escapeHtml(timing)}` : ""}${log.error ? ` · ${escapeHtml(log.error)}` : ""}${log.image_set_id ? ` · ชุดรูป ${escapeHtml(String(log.image_set_index ?? "?"))}/${escapeHtml(String(log.image_set_total ?? "?"))}` : ""}</div>${evidence}${paddleResult}</details>
    </article>`;
  }).join("");
}

function controlPage(enabled: boolean, providers: ProviderStatus): string {
  const statusText = enabled ? "กำลังทำงาน" : "หยุดใช้งาน";
  const statusDetail = enabled
    ? "รูปใหม่จาก LINE จะเข้าคิวและใช้ AI ตรวจสอบตามกฎปัจจุบัน"
    : "รูปใหม่จะไม่เข้าคิว และงานค้างจะถูกข้ามโดยไม่ใช้ AI";
  const nextAction = enabled ? "disable" : "enable";
  const buttonText = enabled ? "หยุดระบบตรวจรูป" : "เปิดระบบตรวจรูป";
  const actionForm = enabled
    ? `<form class="action" method="get" action="/control/confirm"><input type="hidden" name="target" value="disable"><button type="submit">${buttonText}</button></form>`
    : `<form class="action" method="post" action="/control/toggle"><input type="hidden" name="action" value="${nextAction}"><button type="submit">${buttonText}</button></form>`;
  const ocrSpaceRemaining = Math.max(
    OCR_SPACE_DAILY_LIMIT - providers.ocrSpaceUsage,
    0,
  );
  const ocrSpaceState = !enabled
    ? "หยุดตามระบบหลัก"
    : !providers.ocrSpaceConfigured
      ? "ยังไม่ได้ตั้งค่า API key"
      : ocrSpaceRemaining > 0
        ? `พร้อมใช้งาน · เหลือ ${ocrSpaceRemaining} รูป`
        : "ครบโควตาวันนี้ · ข้ามไป Workers AI";
  const googleVisionRemaining = Math.max(
    GOOGLE_VISION_FREE_MONTHLY_UNITS - providers.googleVisionUsage,
    0,
  );
  const googleVisionTone = providers.googleVisionUsage >= 950
    ? "danger"
    : providers.googleVisionUsage >= 800
      ? "warn"
      : "ok";
  const googleVisionState = !enabled
    ? "หยุดตามระบบหลัก"
    : !providers.googleVisionConfigured
      ? "ยังไม่ได้ตั้งค่า API key"
      : googleVisionRemaining === 0
        ? "ถึงเพดานความปลอดภัย · หยุดเรียกอัตโนมัติ"
        : providers.googleVisionUsage >= 950
          ? `ใกล้ถึงเพดานมาก · คาดว่าเหลือ ${googleVisionRemaining} units`
          : providers.googleVisionUsage >= 800
            ? `เริ่มเข้าเขตเตือน · คาดว่าเหลือ ${googleVisionRemaining} units`
            : `ตั้งค่าคีย์แล้ว · คาดว่าเหลือ ${googleVisionRemaining} units`;
  const queueOperations = providers.dailyStats.queueWrites
    + providers.dailyStats.queueReads
    + providers.dailyStats.queueDeletes;
  const queueRemaining = Math.max(QUEUE_DAILY_FREE_LIMIT - queueOperations, 0);
  const queueTone = queueOperations >= QUEUE_DAILY_FREE_LIMIT * 0.9
    ? "danger"
    : queueOperations >= QUEUE_DAILY_FREE_LIMIT * 0.75
      ? "warn"
      : "ok";
  const queuePercent = Math.min(
    (queueOperations / QUEUE_DAILY_FREE_LIMIT) * 100,
    100,
  );
  const recentLogs = logCards(providers.logs);
  const updatedAt = bangkokTime(new Date());
  const versionId = escapeHtml(providers.versionId || "local");
  const versionShort = versionId === "local" ? versionId : versionId.slice(0, 8);
  const versionTitle = escapeHtml(
    [providers.versionId, providers.versionTimestamp].filter(Boolean).join(" · "),
  );
  const alerts = serviceAlerts(enabled, providers);
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KPLUS Control</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Noto Sans Thai",system-ui,sans-serif;background:#07100c;color:#f1fff7}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,#163e29 0,transparent 36%),#07100c;padding:22px}
    .shell{width:min(100%,720px);margin:34px auto}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.brand{display:flex;gap:13px;align-items:center}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:#25d366;color:#07110c;font-size:21px;font-weight:900}.brand strong{display:block;font-size:19px}.brand span{color:#789486;font-size:13px}
    .logout{margin:0}.logout button{border:1px solid #304c3d;border-radius:10px;background:transparent;color:#a9c2b4;padding:9px 13px;cursor:pointer}
    .panel{position:relative;overflow:hidden;padding:34px;border:1px solid ${enabled ? "#2f7350" : "#663b41"};border-radius:26px;background:linear-gradient(145deg,${enabled ? "#112d1f,#0d1c15" : "#2c171b,#171113"});box-shadow:0 28px 90px #0007}
    .eyebrow{display:flex;gap:9px;align-items:center;color:#9eb8aa;font-weight:700;font-size:14px}.dot{width:11px;height:11px;border-radius:50%;background:${enabled ? "#30dc78" : "#ee6474"};box-shadow:0 0 18px ${enabled ? "#30dc78" : "#ee6474"}}
    h1{font-size:clamp(35px,8vw,58px);letter-spacing:-.04em;margin:18px 0 12px;color:${enabled ? "#dffff0" : "#ffe8eb"}}.detail{max-width:540px;margin:0;color:#a8c0b2;line-height:1.7;font-size:16px}
    .action{margin-top:30px}.action button{width:100%;padding:18px 22px;border:0;border-radius:15px;font-size:18px;font-weight:900;cursor:pointer;background:${enabled ? "#f06474" : "#31dc79"};color:${enabled ? "#2b090e" : "#06110b"}}.action button:hover{filter:brightness(1.08)}
    .pipeline{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:20px}.step{position:relative;padding:15px;border:1px solid #294537;border-radius:14px;background:#0a1710}.step small{display:block;color:#718d7e;margin-bottom:5px}.step b{font-size:15px}.step em{display:block;margin-top:7px;color:#8ca799;font-size:12px;font-style:normal;line-height:1.45}.step:not(:last-child)::after{content:"›";position:absolute;right:-9px;top:50%;z-index:2;color:#35d87a;font-size:22px;transform:translateY(-50%)}
    .section-title{margin:22px 0 10px;color:#a8c0b2;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}.item{padding:15px;border:1px solid #294537;border-radius:14px;background:#0a1710}.item small{display:block;color:#718d7e;margin-bottom:5px}.item b{font-size:15px}.item em{display:block;margin-top:7px;color:#8ca799;font-size:12px;font-style:normal;line-height:1.45}.item .ok{color:#5aeb94}.item .warn{color:#ffd477}.item .danger{color:#ff7888}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{padding:13px;border:1px solid #294537;border-radius:13px;background:#0a1710}.stat small{display:block;color:#718d7e;font-size:11px}.stat strong{display:block;margin-top:5px;font-size:22px}.stat.wide{grid-column:span 2}.stat em{display:block;margin-top:5px;color:#8ca799;font-size:11px;font-style:normal;line-height:1.4}
    .meter{height:7px;margin-top:11px;border-radius:99px;background:#203429;overflow:hidden}.meter span{display:block;height:100%;width:${Math.min((providers.ocrSpaceUsage / OCR_SPACE_DAILY_LIMIT) * 100, 100)}%;background:${ocrSpaceRemaining > 0 ? "#30dc78" : "#f06474"}}
    .notice{margin-top:16px;padding:14px 16px;border-radius:13px;background:#172019;color:#91aa9c;font-size:13px;line-height:1.6;border:1px solid #293a30}
    .control-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:15px;color:#8fa99a;font-size:11px}.control-bar .version{padding:5px 8px;border:1px solid #345342;border-radius:999px;background:#0b1811;color:#b8d2c3}.nav-actions{display:flex;gap:7px;margin-left:auto}.refresh{padding:7px 11px;border:1px solid #3a6a50;border-radius:9px;color:#7ef0aa;text-decoration:none;background:#10271a;font-weight:800}.manage{border-color:#437055;color:#d9ffe7}.service-health{margin:16px 0 0;padding:11px 13px;border-radius:12px;font-size:12px;line-height:1.5}.service-health.ok{border:1px solid #2f7350;background:#102b1c;color:#74eba2}.service-health.warning{border:1px solid #8a6230;background:#302413;color:#ffd58d}.service-health ul{margin:7px 0 0;padding-left:20px}
    .logs{display:grid;gap:8px}.log-row,.log-empty{position:relative;overflow:hidden;padding:10px 12px;border:1px solid #294537;border-left:4px solid #536b5e;border-radius:11px;background:#0a1710}.log-row.pass{border-left-color:#36e77c;background:linear-gradient(90deg,#123522 0,#0a1710 28%)}.log-row.fail{border-left-color:#ff6478;background:linear-gradient(90deg,#35171d 0,#0a1710 28%)}.log-row.error{border-left-color:#ffad55;background:linear-gradient(90deg,#352515 0,#0a1710 28%)}.log-row.ignored{border-left-color:#71877b}.log-main{display:grid;grid-template-columns:88px 66px 72px minmax(165px,1fr) 96px 88px;gap:8px;align-items:center}.outcome-badge{display:inline-flex;align-items:center;gap:7px;font-size:14px;white-space:nowrap}.outcome-badge i,.evidence-chip i{display:grid;place-items:center;font-style:normal;font-weight:900}.outcome-badge i{width:22px;height:22px;border-radius:50%;background:#52695d;color:#fff}.pass .outcome-badge{color:#70f5a5}.pass .outcome-badge i{background:#2bc96c;color:#05200f}.fail .outcome-badge{color:#ff8c9a}.fail .outcome-badge i{background:#e05264}.error .outcome-badge{color:#ffc17e}.error .outcome-badge i{background:#ef9c45;color:#251406}.log-cell{font-size:12px;min-width:0}.log-cell small{display:block;color:#789486;font-size:9px;margin-bottom:1px}.job-value,.amount-value{display:block;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:#f4fff8;letter-spacing:.02em;white-space:nowrap}.pass .amount-value{color:#70f5a5}.fail .amount-value{color:#ff9aa6}.evidence-row{display:flex;flex-wrap:wrap;gap:6px;margin:0;min-width:0}.evidence-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 7px;border:1px solid #43574c;border-radius:999px;background:#142019;color:#9db1a6;font-size:10px;font-weight:800;white-space:nowrap}.evidence-chip i{width:14px;height:14px;border-radius:50%;font-size:9px}.evidence-chip.found{border-color:#2bc96c;background:#123a23;color:#79f5a8}.evidence-chip.found i{background:#2bc96c;color:#05200f}.evidence-chip.missing{border-color:#b84554;background:#38181e;color:#ff9aa7}.evidence-chip.missing i{background:#d84f61;color:#fff}.evidence-chip.unknown i{background:#52695d;color:#fff}.evidence-chip.provider{border-color:#39745a;background:#102c1d;color:#9bf2bc}.evidence-chip.provider i{background:#39c976;color:#062513}.log-meta{display:grid;min-width:0;justify-items:end;color:#9ab2a5;font-size:9px;line-height:1.45;white-space:normal;text-align:right}.log-more{margin-top:5px;color:#789486;font-size:10px}.log-more summary{width:max-content;cursor:pointer;color:#8eaa9b}.log-more div{margin-top:5px;padding-top:5px;border-top:1px solid #294537;line-height:1.5;overflow-wrap:anywhere}.paddle-result{margin-top:8px;padding:9px;border:1px solid #315443;border-radius:10px;background:#08140d}.paddle-result b{display:block;color:#74eba2;font-size:11px}.paddle-result p{margin:7px 0 0;color:#789486}.paddle-result pre{max-height:240px;margin:7px 0 0;padding:9px;border-radius:8px;background:#050c08;color:#d9ffe7;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow:auto}.log-actions{display:flex;justify-content:space-between;align-items:center;margin:22px 0 10px}.log-actions .section-title{margin:0}.clear-logs button{border:1px solid #663b41;border-radius:9px;background:transparent;color:#ff9daa;padding:7px 10px;cursor:pointer}.log-empty{color:#789486;text-align:center}
    .delivery-chip{display:inline-flex;min-width:0;justify-content:center;overflow:hidden;text-overflow:ellipsis;padding:5px 7px;border:1px solid #42584c;border-radius:999px;font-size:9px;font-weight:900;white-space:nowrap}.delivery-chip.sent{border-color:#2bc96c;background:#123a23;color:#79f5a8}.delivery-chip.pending{border-color:#b88b39;background:#352a15;color:#ffd477}.delivery-chip.failed{border-color:#b84554;background:#38181e;color:#ff9aa7}.delivery-chip.none{color:#83988c;background:#142019}
    @media(max-width:900px){.pipeline{grid-template-columns:repeat(2,1fr)}.step:nth-child(2)::after{display:none}.log-main{grid-template-columns:84px 68px 76px minmax(180px,1fr) 92px;column-gap:8px;row-gap:4px}.log-meta{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}}
    @media(max-width:650px){body{padding:15px}.shell{margin:12px auto}.panel{padding:25px}.pipeline,.meta{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.step:not(:last-child)::after{content:"↓";right:50%;top:auto;bottom:-18px;transform:translateX(50%)}.brand span{display:none}.log-main{grid-template-columns:1fr 1fr;gap:8px}.evidence-row{grid-column:1/-1}.log-meta{display:grid;justify-items:start;text-align:left}}
  </style>
</head>
<body><main class="shell"><header class="top"><div class="brand"><div class="mark">K+</div><div><strong>KPLUS Control</strong><span>LINE receipt inspection</span></div></div><form class="logout" method="post" action="/control/logout"><button type="submit">ออกจากระบบ</button></form></header>
  <section class="panel"><div class="control-bar"><span>อัปเดตล่าสุด ${escapeHtml(updatedAt)}</span><span class="version" title="${versionTitle}">เวอร์ชัน ${versionShort}</span><span class="nav-actions"><a class="refresh manage" href="/control/technicians">จัดการช่าง</a><a class="refresh" href="/control">รีเฟรช</a></span></div><div class="eyebrow"><span class="dot"></span>สถานะระบบล่าสุด</div><h1>${statusText}</h1><p class="detail">${statusDetail}</p>
  ${alerts}
  ${actionForm}
  <div class="pipeline"><div class="step"><small>ขั้นที่ 1</small><b>PaddleOCR</b><em>ตัวตรวจหลัก · สูงสุด 5 งานพร้อมกัน</em></div><div class="step"><small>ขั้นที่ 2</small><b>OCR.space</b><em>สำรองเมื่อ Paddle ขัดข้อง · สูงสุด 2 งาน</em></div><div class="step"><small>ขั้นที่ 3</small><b>Workers AI</b><em>ตรวจเมื่อข้อความยังไม่ชัดเจน</em></div><div class="step"><small>ขั้นที่ 4</small><b>Google Vision</b><em>ตรวจยืนยันขั้นสุดท้าย</em></div></div>
  <div class="section-title">สถิติวันนี้</div>
  <div class="stats">
    <div class="stat"><small>รับเข้าคิว</small><strong>${providers.dailyStats.received}</strong></div>
    <div class="stat"><small>ตรวจจบ</small><strong>${providers.dailyStats.processed}</strong></div>
    <div class="stat"><small>ผ่าน</small><strong>${providers.dailyStats.passed}</strong></div>
    <div class="stat"><small>ไม่ผ่าน</small><strong>${providers.dailyStats.failed}</strong></div>
    <div class="stat"><small>ข้าม/เงียบ</small><strong>${providers.dailyStats.ignored}</strong></div>
    <div class="stat"><small>รูปซ้ำที่กันไว้</small><strong>${providers.dailyStats.duplicates}</strong></div>
    <div class="stat"><small>ข้อผิดพลาด</small><strong>${providers.dailyStats.errors}</strong></div>
    <div class="stat"><small>Google ชนเพดาน</small><strong>${providers.dailyStats.googleVisionCapSkips}</strong></div>
    <div class="stat wide"><small>การเรียกบริการวันนี้</small><strong>${providers.dailyStats.ocrSpaceCalls} · ${providers.dailyStats.workersAiCalls} · ${providers.dailyStats.googleVisionCalls}</strong><em>OCR.space · Workers AI · Google Vision</em></div>
    <div class="stat wide"><small>ข้อผิดพลาดแยกบริการ</small><strong>${providers.dailyStats.ocrSpaceErrors} · ${providers.dailyStats.workersAiErrors} · ${providers.dailyStats.googleVisionErrors}</strong><em>OCR.space · Workers AI · Google Vision</em></div>
  </div>
  <div class="section-title">โควตาและการตั้งค่า</div>
  <div class="meta">
    <div class="item"><small>PaddleOCR</small><b class="${providers.paddleOcrConfigured ? "ok" : "warn"}">${providers.paddleOcrConfigured ? "พร้อมใช้งาน" : "ยังไม่ได้ตั้งค่า token"}</b><em>ตัวตรวจหลัก · ผลข้อความจะแสดงในรายละเอียด Log</em></div>
    <div class="item"><small>OCR.space วันนี้</small><b class="${providers.ocrSpaceConfigured ? "ok" : "warn"}">${providers.ocrSpaceUsage} / ${OCR_SPACE_DAILY_LIMIT} รูป</b><div class="meter"><span></span></div><em>${ocrSpaceState}</em></div>
    <div class="item"><small>Workers AI</small><b class="${enabled ? "ok" : ""}">${enabled ? "พร้อมเป็นระบบสำรอง" : "ไม่ถูกเรียกใช้งาน"}</b><em>ระบบไม่สามารถอ่านโควตาคงเหลือจาก binding ได้</em></div>
    <div class="item"><small>Google Vision เดือนนี้ (ประมาณการ)</small><b class="${googleVisionTone}">${providers.googleVisionUsage} / ${GOOGLE_VISION_FREE_MONTHLY_UNITS} units</b><div class="meter"><span style="width:${Math.min((providers.googleVisionUsage / GOOGLE_VISION_FREE_MONTHLY_UNITS) * 100, 100)}%;background:${googleVisionTone === "danger" ? "#f06474" : googleVisionTone === "warn" ? "#ffd477" : "#30dc78"}"></span></div><em>${googleVisionState}</em></div>
    <div class="item"><small>Cloudflare Queue วันนี้ (ประมาณการ)</small><b class="${queueTone}">${queueOperations.toLocaleString("en-US")} / ${QUEUE_DAILY_FREE_LIMIT.toLocaleString("en-US")} operations</b><div class="meter"><span style="width:${queuePercent}%;background:${queueTone === "danger" ? "#f06474" : queueTone === "warn" ? "#ffd477" : "#30dc78"}"></span></div><em>เหลือ ${queueRemaining.toLocaleString("en-US")} · เขียน ${providers.dailyStats.queueWrites.toLocaleString("en-US")} · อ่าน ${providers.dailyStats.queueReads.toLocaleString("en-US")} · ลบ ${providers.dailyStats.queueDeletes.toLocaleString("en-US")}</em></div>
    <div class="item"><small>คิวและกฎปัจจุบัน</small><b>Paddle 5 งาน · OCR.space 2 งาน · รวมผลตามกลุ่มและผู้ส่ง</b><em>รับเลขงาน 8 หลักก่อนรูป · KPLUS/K+/Thai QR Payment + SETTLEMENT + ยอด 1.22 หรือ -1.22</em></div>
  </div>
  <div class="notice">OCR.space นับตามวันที่ประเทศไทย ส่วน Google Vision และ Queue เป็นค่าประมาณจากตัวนับของ Worker นี้ ตัวนับ Queue เริ่มเก็บตั้งแต่เวอร์ชันที่เปิดใช้การแสดงผล จึงไม่รวมยอดก่อนหน้านี้หรือระบบอื่นในบัญชี Cloudflare</div>
  <div class="log-actions"><div class="section-title">Log การตรวจล่าสุด 50 รูป</div><form class="clear-logs" method="get" action="/control/confirm"><input type="hidden" name="target" value="clear-logs"><button type="submit">ล้าง Log</button></form></div>
  <div class="logs">${recentLogs}</div></section></main></body></html>`;
}

async function safeInspectionLogs(db: D1Database): Promise<InspectionLogRow[]> {
  try {
    return await listInspectionLogs(db);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "inspection_logs_load_failed",
      error: error instanceof Error ? error.message : "unknown error",
    }));
    return [];
  }
}

export async function handleControlRequest(
  request: Request,
  env: Pick<
    Env,
    "CONTROL_PASSWORD" | "CONTROL_DB" | "OPERATIONAL_COUNTERS" | "PADDLEOCR_TOKEN" | "OCR_SPACE_API_KEY" | "GOOGLE_VISION_API_KEY" | "PROCESSING_FORCE_DISABLED"
  > & { CF_VERSION_METADATA?: WorkerVersionMetadata },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/control")) return null;
  if (!env.CONTROL_PASSWORD) {
    return htmlResponse("Control password is not configured", 503);
  }

  if (request.method === "POST" && url.pathname === "/control/login") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!(await constantTimeEqual(password, env.CONTROL_PASSWORD))) {
      console.warn(JSON.stringify({ event: "control_login_failed" }));
      return htmlResponse(loginPage("รหัสผ่านไม่ถูกต้อง"), 401);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const token = await signSession(expiresAt, env.CONTROL_PASSWORD);
    return redirectToControl(
      `${SESSION_COOKIE}=${token}; Path=/control; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    );
  }

  const authenticated = await hasValidSession(request, env.CONTROL_PASSWORD);
  if (!authenticated) return htmlResponse(loginPage());

  if (request.method === "GET" && url.pathname === "/control/technicians") {
    const mentions = await listServiceAreaMentions(env.CONTROL_DB);
    return htmlResponse(techniciansPage(mentions));
  }

  if (request.method === "POST" && url.pathname === "/control/technicians/save") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    const form = await request.formData();
    const input = mentionInputFromForm(form);
    const rawId = String(form.get("id") ?? "").trim();
    const id = rawId ? Number(rawId) : undefined;
    try {
      await saveServiceAreaMention(env.CONTROL_DB, input, id);
      console.log(JSON.stringify({
        event: id === undefined
          ? "service_area_mention_created"
          : "service_area_mention_updated",
        id,
        province: input.province,
        district: input.district,
        enabled: input.enabled,
      }));
      return redirectTo("/control/technicians");
    } catch (error) {
      const mentions = await listServiceAreaMentions(env.CONTROL_DB);
      return htmlResponse(
        techniciansPage(mentions, friendlyMentionError(error), input),
        400,
      );
    }
  }

  if (request.method === "GET" && url.pathname === "/control/technicians/delete") {
    const mention = await getServiceAreaMention(
      env.CONTROL_DB,
      Number(url.searchParams.get("id")),
    );
    if (!mention) return htmlResponse("ไม่พบรายการ", 404);
    return htmlResponse(technicianDeletePage(mention));
  }

  if (request.method === "POST" && url.pathname === "/control/technicians/delete") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    const form = await request.formData();
    const id = Number(form.get("id"));
    try {
      await deleteServiceAreaMention(env.CONTROL_DB, id);
    } catch (error) {
      return htmlResponse(friendlyMentionError(error), 400);
    }
    console.log(JSON.stringify({ event: "service_area_mention_deleted", id }));
    return redirectTo("/control/technicians");
  }

  if (request.method === "GET" && url.pathname === "/control/confirm") {
    const target = url.searchParams.get("target");
    if (target !== "disable" && target !== "clear-logs") {
      return htmlResponse("Invalid confirmation target", 400);
    }
    return htmlResponse(confirmPage(target));
  }

  if (request.method === "GET" && (url.pathname === "/control" || url.pathname === "/control/")) {
    const [enabled, ocrSpaceUsage, googleVisionUsage, dailyStats, logs] = await Promise.all([
      isProcessingEnabled(
        env.CONTROL_DB,
        String(env.PROCESSING_FORCE_DISABLED) === "true",
      ),
      getOcrSpaceUsage(env.OPERATIONAL_COUNTERS),
      getGoogleVisionUsage(env.OPERATIONAL_COUNTERS),
      getDailyStats(env.OPERATIONAL_COUNTERS),
      safeInspectionLogs(env.CONTROL_DB),
    ]);
    return htmlResponse(controlPage(enabled, {
      paddleOcrConfigured: Boolean(env.PADDLEOCR_TOKEN),
      ocrSpaceConfigured: Boolean(env.OCR_SPACE_API_KEY),
      ocrSpaceUsage,
      googleVisionConfigured: Boolean(env.GOOGLE_VISION_API_KEY),
      googleVisionUsage,
      dailyStats,
      logs,
      versionId: env.CF_VERSION_METADATA?.id ?? "local",
      versionTimestamp: env.CF_VERSION_METADATA?.timestamp ?? "",
    }));
  }

  if (request.method === "POST" && url.pathname === "/control/logs/clear") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    await clearInspectionLogs(env.CONTROL_DB);
    console.log(JSON.stringify({ event: "inspection_logs_cleared" }));
    return redirectToControl();
  }

  if (request.method === "POST" && url.pathname === "/control/toggle") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    const form = await request.formData();
    const action = form.get("action");
    if (action !== "enable" && action !== "disable") {
      return htmlResponse("Invalid action", 400);
    }
    if (String(env.PROCESSING_FORCE_DISABLED) === "true") {
      return redirectToControl();
    }
    const enabled = action === "enable";
    await setProcessingEnabled(env.CONTROL_DB, enabled);
    console.log(JSON.stringify({ event: "processing_control_changed", enabled }));
    return redirectToControl();
  }

  if (request.method === "POST" && url.pathname === "/control/logout") {
    if (!sameOrigin(request)) return htmlResponse("Forbidden", 403);
    return redirectToControl(
      `${SESSION_COOKIE}=; Path=/control; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    );
  }

  return htmlResponse("Not found", 404);
}
