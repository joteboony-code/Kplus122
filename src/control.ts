import { getOcrSpaceUsage, OCR_SPACE_DAILY_LIMIT } from "./ocr-space-usage";
import {
  getGoogleVisionUsage,
  GOOGLE_VISION_FREE_MONTHLY_UNITS,
} from "./google-vision-usage";
import { getDailyStats, type DailyStats } from "./daily-stats";

const PROCESSING_ENABLED_KEY = "control:processing-enabled";
const SESSION_COOKIE = "kplus_control_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

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

function redirectToControl(cookie?: string): Response {
  const headers = new Headers({
    Location: "/control",
    ...securityHeaders("text/plain; charset=utf-8"),
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response("Redirecting", { status: 303, headers });
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

interface ProviderStatus {
  ocrSpaceConfigured: boolean;
  ocrSpaceUsage: number;
  googleVisionConfigured: boolean;
  googleVisionUsage: number;
  dailyStats: DailyStats;
}

function controlPage(enabled: boolean, providers: ProviderStatus): string {
  const statusText = enabled ? "กำลังทำงาน" : "หยุดใช้งาน";
  const statusDetail = enabled
    ? "รูปใหม่จาก LINE จะเข้าคิวและใช้ AI ตรวจสอบตามกฎปัจจุบัน"
    : "รูปใหม่จะไม่เข้าคิว และงานค้างจะถูกข้ามโดยไม่ใช้ AI";
  const nextAction = enabled ? "disable" : "enable";
  const buttonText = enabled ? "หยุดระบบตรวจรูป" : "เปิดระบบตรวจรูป";
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
    .pipeline{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px}.step{position:relative;padding:15px;border:1px solid #294537;border-radius:14px;background:#0a1710}.step small{display:block;color:#718d7e;margin-bottom:5px}.step b{font-size:15px}.step em{display:block;margin-top:7px;color:#8ca799;font-size:12px;font-style:normal;line-height:1.45}.step:not(:last-child)::after{content:"›";position:absolute;right:-9px;top:50%;z-index:2;color:#35d87a;font-size:22px;transform:translateY(-50%)}
    .section-title{margin:22px 0 10px;color:#a8c0b2;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}.item{padding:15px;border:1px solid #294537;border-radius:14px;background:#0a1710}.item small{display:block;color:#718d7e;margin-bottom:5px}.item b{font-size:15px}.item em{display:block;margin-top:7px;color:#8ca799;font-size:12px;font-style:normal;line-height:1.45}.item .ok{color:#5aeb94}.item .warn{color:#ffd477}.item .danger{color:#ff7888}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{padding:13px;border:1px solid #294537;border-radius:13px;background:#0a1710}.stat small{display:block;color:#718d7e;font-size:11px}.stat strong{display:block;margin-top:5px;font-size:22px}.stat.wide{grid-column:span 2}.stat em{display:block;margin-top:5px;color:#8ca799;font-size:11px;font-style:normal;line-height:1.4}
    .meter{height:7px;margin-top:11px;border-radius:99px;background:#203429;overflow:hidden}.meter span{display:block;height:100%;width:${Math.min((providers.ocrSpaceUsage / OCR_SPACE_DAILY_LIMIT) * 100, 100)}%;background:${ocrSpaceRemaining > 0 ? "#30dc78" : "#f06474"}}
    .notice{margin-top:16px;padding:14px 16px;border-radius:13px;background:#172019;color:#91aa9c;font-size:13px;line-height:1.6;border:1px solid #293a30}
    @media(max-width:650px){body{padding:15px}.shell{margin:12px auto}.panel{padding:25px}.pipeline,.meta{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.step:not(:last-child)::after{content:"↓";right:50%;top:auto;bottom:-18px;transform:translateX(50%)}.brand span{display:none}}
  </style>
</head>
<body><main class="shell"><header class="top"><div class="brand"><div class="mark">K+</div><div><strong>KPLUS Control</strong><span>LINE receipt inspection</span></div></div><form class="logout" method="post" action="/control/logout"><button type="submit">ออกจากระบบ</button></form></header>
  <section class="panel"><div class="eyebrow"><span class="dot"></span>สถานะระบบล่าสุด</div><h1>${statusText}</h1><p class="detail">${statusDetail}</p>
  <form class="action" method="post" action="/control/toggle"><input type="hidden" name="action" value="${nextAction}"><button type="submit">${buttonText}</button></form>
  <div class="pipeline"><div class="step"><small>ขั้นที่ 1</small><b>OCR.space</b><em>ตรวจ 500 รูปแรกของวัน</em></div><div class="step"><small>ขั้นที่ 2</small><b>Workers AI</b><em>ตรวจเมื่อ OCR.space ครบหรือข้อมูลไม่พอ</em></div><div class="step"><small>ขั้นที่ 3</small><b>Google Vision</b><em>ตรวจยืนยันเมื่อ Workers AI ยังตัดสินไม่ได้</em></div></div>
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
    <div class="item"><small>OCR.space วันนี้</small><b class="${providers.ocrSpaceConfigured ? "ok" : "warn"}">${providers.ocrSpaceUsage} / ${OCR_SPACE_DAILY_LIMIT} รูป</b><div class="meter"><span></span></div><em>${ocrSpaceState}</em></div>
    <div class="item"><small>Workers AI</small><b class="${enabled ? "ok" : ""}">${enabled ? "พร้อมเป็นระบบสำรอง" : "ไม่ถูกเรียกใช้งาน"}</b><em>ระบบไม่สามารถอ่านโควตาคงเหลือจาก binding ได้</em></div>
    <div class="item"><small>Google Vision เดือนนี้ (ประมาณการ)</small><b class="${googleVisionTone}">${providers.googleVisionUsage} / ${GOOGLE_VISION_FREE_MONTHLY_UNITS} units</b><div class="meter"><span style="width:${Math.min((providers.googleVisionUsage / GOOGLE_VISION_FREE_MONTHLY_UNITS) * 100, 100)}%;background:${googleVisionTone === "danger" ? "#f06474" : googleVisionTone === "warn" ? "#ffd477" : "#30dc78"}"></span></div><em>${googleVisionState}</em></div>
    <div class="item"><small>คิวและกฎปัจจุบัน</small><b>1 ชุดรูป LINE (imageSet) = 1 รอบ · ต้องพบสลิปคนละ 2 ใบ</b><em>KPLUS/K+ + SETTLEMENT + ยอด 1.22/-1.22 · KBANK + SETTLEMENT + ยอดใดก็ได้ · fallback 5 นาทีเมื่อไม่มีรหัสชุด</em></div>
  </div>
  <div class="notice">OCR.space นับตามวันที่ประเทศไทย ส่วน Google Vision เป็นค่าประมาณรายเดือนที่นับเฉพาะคำขอสำเร็จจาก Worker นี้ตั้งแต่เริ่มใช้ตัวนับ ไม่รวมระบบอื่นใน Google Cloud Project การเปลี่ยนสถานะอาจใช้เวลาสั้น ๆ ก่อนมีผลครบทุกศูนย์ข้อมูล</div></section></main></body></html>`;
}

export async function handleControlRequest(
  request: Request,
  env: Pick<
    Env,
    "CONTROL_PASSWORD" | "CONTROL_DB" | "REPLY_STATE" | "OCR_SPACE_API_KEY" | "GOOGLE_VISION_API_KEY" | "PROCESSING_FORCE_DISABLED"
  >,
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

  if (request.method === "GET" && (url.pathname === "/control" || url.pathname === "/control/")) {
    const [enabled, ocrSpaceUsage, googleVisionUsage, dailyStats] = await Promise.all([
      isProcessingEnabled(
        env.CONTROL_DB,
        String(env.PROCESSING_FORCE_DISABLED) === "true",
      ),
      getOcrSpaceUsage(env.REPLY_STATE),
      getGoogleVisionUsage(env.REPLY_STATE),
      getDailyStats(env.REPLY_STATE),
    ]);
    return htmlResponse(controlPage(enabled, {
      ocrSpaceConfigured: Boolean(env.OCR_SPACE_API_KEY),
      ocrSpaceUsage,
      googleVisionConfigured: Boolean(env.GOOGLE_VISION_API_KEY),
      googleVisionUsage,
      dailyStats,
    }));
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
