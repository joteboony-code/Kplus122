import type { ReceiptDecision, ReceiptInspection } from "./types";

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct" as const;

// Keep target brand, expected amounts, and pass/fail terms out of this prompt.
// The model only transcribes; deterministic code below makes every decision.
export const VISIBLE_TEXT_PROMPT = `Transcribe only text that is clearly visible in this image.
Preserve line breaks, decimal points, and minus signs exactly as printed.
Do not describe the image, infer hidden text, correct values, or add commentary.
If no text is readable, return NONE.`;

export const KPLUS_VISUAL_PROMPT = `Classify whether this image visibly contains a KBank K+ or KPLUS merchant payment receipt.
Return CANDIDATE only when a standalone K+ logo/mark or the printed word KPLUS is visibly present.
Do not use receipt layout or words such as SALE, VOID, THB, or SETTLEMENT as evidence.
Do not count KBank branding, KBank Cash equipment labels, or KBank credit-card receipts unless K+ or KPLUS is also visible.
Return exactly CANDIDATE or NOT_CANDIDATE. Do not explain.`;

function aiResponseText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("response" in value)) {
    throw new Error("Workers AI returned an unexpected response");
  }
  const response = value.response;
  if (typeof response !== "string") {
    throw new Error("Workers AI response text is missing");
  }
  return response.trim();
}

export async function transcribeVisibleText(
  ai: Ai,
  image: Uint8Array,
): Promise<string> {
  const result = await ai.run(MODEL, {
    prompt: VISIBLE_TEXT_PROMPT,
    image: Array.from(image),
    max_tokens: 500,
    temperature: 0,
  });
  return aiResponseText(result);
}

export function parseKplusVisualCandidate(value: string): boolean {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z_]+/g, " ");
  if (/\bNOT[_ ]?CANDIDATE\b/.test(normalized)) return false;
  return /\bCANDIDATE\b/.test(normalized);
}

export async function classifyKplusVisualCandidate(
  ai: Ai,
  image: Uint8Array,
): Promise<boolean> {
  const result = await ai.run(MODEL, {
    prompt: KPLUS_VISUAL_PROMPT,
    image: Array.from(image),
    max_tokens: 12,
    temperature: 0,
  });
  return parseKplusVisualCandidate(aiResponseText(result));
}

function normalizeOcrText(text: string): string {
  return text
    .toUpperCase()
    .replace(/\r/g, "\n")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/-\s*THB\s*/g, "THB -")
    .replace(/THB\s*-\s*/g, "THB -")
    .replace(/\s+/g, " ")
    .trim();
}

export function isKplusCandidateText(text: string): boolean {
  const normalized = normalizeOcrText(text);
  return (
    /\bKPLUS\b/.test(normalized) ||
    /(?:^|[^A-Z0-9])K\s*\+(?:[^A-Z0-9]|$)/.test(normalized)
  );
}

export function isConfirmedKplusReceiptText(text: string): boolean {
  const normalized = normalizeOcrText(text);
  const hasStandaloneKplusLogo =
    /(?:^|[^A-Z0-9])K\s*\+(?:[^A-Z0-9]|$)/.test(normalized);
  if (hasStandaloneKplusLogo) return true;
  if (!/\bKPLUS\b/.test(normalized)) return false;

  return (
    /\b(?:CHANNEL|HOST|CARD\s*NAME)\s*:?\s*KPLUS\b/.test(normalized) ||
    hasThaiQrPaymentText(normalized)
  );
}

export function hasThaiQrPaymentText(text: string): boolean {
  const normalized = normalizeOcrText(text);
  return /\b(?:THAI\s*QR(?:\s*PAYMENT)?|QR\s*PAYMENT)\b/.test(normalized);
}

export function hasSettlementText(text: string): boolean {
  return /\bSETTLEMENT\b/.test(normalizeOcrText(text));
}

export function acceptWorkerPaymentName(
  inspection: ReceiptInspection,
  sourceText: string,
): ReceiptInspection {
  if (inspection.isKplusReceipt || !hasThaiQrPaymentText(sourceText)) {
    return inspection;
  }

  return {
    ...inspection,
    isKplusReceipt: true,
    confidence: inspection.observedAmounts.length > 0 ? 0.99 : 0.8,
    reason: `acceptedPaymentName=thai-qr; ${inspection.reason}`,
  };
}

function amountsFromText(normalized: string): number[] {
  const values = [...normalized.matchAll(/(?:THB\s*)?(-?\d+[.]\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return [...new Set(values)];
}

export function inspectReceiptText(text: string): ReceiptInspection {
  const normalized = normalizeOcrText(text);
  const isKplusReceipt = isKplusCandidateText(normalized);
  const hasSettlement = hasSettlementText(normalized);
  const observedAmounts = amountsFromText(normalized);

  return {
    isKplusReceipt,
    hasSettlement,
    observedAmounts,
    confidence: isKplusReceipt && observedAmounts.length > 0 ? 0.99 : isKplusReceipt ? 0.8 : 0.2,
    reason: `brand=${isKplusReceipt}; settlement=${hasSettlement}; amounts=${observedAmounts.join(",") || "none"}`,
  };
}

export function inspectConfirmedReceiptText(text: string): ReceiptInspection {
  const normalized = normalizeOcrText(text);
  const isKplusReceipt = isConfirmedKplusReceiptText(normalized);
  const hasSettlement = hasSettlementText(normalized);
  const observedAmounts = amountsFromText(normalized);

  return {
    isKplusReceipt,
    hasSettlement,
    observedAmounts,
    confidence: isKplusReceipt && observedAmounts.length > 0 ? 0.99 : isKplusReceipt ? 0.8 : 0.2,
    reason: `confirmedBrand=${isKplusReceipt}; settlement=${hasSettlement}; amounts=${observedAmounts.join(",") || "none"}`,
  };
}

function amountsEqual(actual: number | null, expected: number): boolean {
  return actual !== null && Math.abs(actual - expected) < 0.005;
}

export function hasExpectedAmount(
  inspection: ReceiptInspection,
  expectedSale: number,
  expectedVoid: number,
): boolean {
  return inspection.observedAmounts.some(
    (amount) => amountsEqual(amount, expectedSale) || amountsEqual(amount, expectedVoid),
  );
}

export function hasGoogleCandidateTextEvidence(
  inspection: ReceiptInspection,
  expectedSale: number,
  expectedVoid: number,
  sourceText = "",
): boolean {
  return (
    inspection.isKplusReceipt ||
    hasExpectedAmount(inspection, expectedSale, expectedVoid) ||
    hasThaiQrPaymentText(sourceText)
  );
}

export function decideReceipt(
  inspection: ReceiptInspection,
  expectedSale: number,
  expectedVoid: number,
  minConfidence: number,
): ReceiptDecision {
  if (!inspection.isKplusReceipt || inspection.confidence < minConfidence) {
    return { status: "uncertain", failures: ["ภาพไม่ชัดหรือหลักฐานบนใบ KPLUS ไม่ครบ"] };
  }

  const failures: string[] = [];
  if (!inspection.hasSettlement) {
    failures.push("ไม่พบคำว่า SETTLEMENT");
  }
  const hasAllowedAmount = hasExpectedAmount(inspection, expectedSale, expectedVoid);
  if (!hasAllowedAmount) {
    failures.push(
      `ไม่พบยอด ${expectedSale.toFixed(2)} หรือ ${expectedVoid.toFixed(2)} บาท`,
    );
  }

  return failures.length === 0
    ? { status: "pass", failures: [] }
    : { status: "fail", failures };
}

export function shouldReplyAfterGoogleVision(
  inspection: ReceiptInspection,
): boolean {
  return inspection.isKplusReceipt;
}

export function formatDecision(
  inspection: ReceiptInspection,
  decision: ReceiptDecision,
): string {
  if (decision.status === "pass") {
    const matched = inspection.observedAmounts.find(
      (amount) => Math.abs(Math.abs(amount) - 1.22) < 0.005,
    );
    return `✅ ผ่าน: พบ KPLUS/K+/Thai QR Payment, SETTLEMENT และยอด ${(matched ?? 1.22).toFixed(2)} บาท`;
  }
  if (decision.status === "uncertain") {
    return "⚠️ พบ KPLUS/K+ แต่จำนวนเงินไม่ชัด กรุณาถ่ายใหม่ให้เห็นยอดเงิน";
  }

  return [
    "❌ ไม่ผ่าน: ใบ KPLUS",
    `ยอดที่อ่านได้: ${inspection.observedAmounts.length > 0 ? inspection.observedAmounts.map((amount) => amount.toFixed(2)).join(", ") : "อ่านไม่ได้"}`,
    `สาเหตุ: ${decision.failures.join(", ")}`,
  ].join("\n");
}
