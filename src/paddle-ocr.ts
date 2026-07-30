const PADDLEOCR_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";

export const DEFAULT_PADDLEOCR_MODEL = "PaddleOCR-VL-1.6";
export const PADDLEOCR_POLL_DELAY_SECONDS = 3;
export const MAX_PADDLEOCR_POLLS = 6;

export interface PaddleJobStatus {
  state: "pending" | "done";
  text?: string;
}

function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

export function extractPaddleOcrText(jsonl: string): string {
  const text: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: any;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const result = value?.result ?? value;
    for (const item of result?.layoutParsingResults ?? []) {
      const markdown = item?.markdown?.text;
      if (typeof markdown === "string" && markdown.trim()) text.push(markdown);
    }
    for (const item of result?.ocrResults ?? []) {
      const pruned = item?.prunedResult;
      if (typeof pruned === "string" && pruned.trim()) {
        text.push(pruned);
      } else if (pruned && typeof pruned === "object") {
        const recTexts = pruned.rec_texts ?? pruned.recTexts;
        if (Array.isArray(recTexts)) text.push(recTexts.map(String).join("\n"));
      }
    }
  }
  return text.join("\n").trim();
}

export async function submitPaddleOcr(
  imageBytes: Uint8Array,
  token: string,
  model = DEFAULT_PADDLEOCR_MODEL,
): Promise<string> {
  const bytes = imageBytes;
  const form = new FormData();
  form.set("model", model);
  form.set("optionalPayload", JSON.stringify({
    useDocOrientationClassify: true,
    useDocUnwarping: false,
    useChartRecognition: false,
  }));
  const body = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  ) as ArrayBuffer;
  form.set("file", new Blob([body], { type: imageMime(bytes) }), "slip");
  const response = await fetch(PADDLEOCR_JOB_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json<any>().catch(() => null);
  const jobId = payload?.data?.jobId;
  if (!response.ok || payload?.code !== 0 || typeof jobId !== "string" || !jobId) {
    throw new Error(String(payload?.msg ?? `PaddleOCR HTTP ${response.status}`));
  }
  return jobId;
}

export async function pollPaddleOcr(
  jobId: string,
  token: string,
): Promise<PaddleJobStatus> {
  const response = await fetch(`${PADDLEOCR_JOB_URL}/${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json<any>().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(String(payload?.msg ?? `PaddleOCR HTTP ${response.status}`));
  }
  const state = payload?.data?.state;
  if (state === "pending" || state === "running") return { state: "pending" };
  if (state === "failed") {
    throw new Error(String(payload?.data?.errorMsg ?? "PaddleOCR parsing failed"));
  }
  if (state !== "done") throw new Error(`Unknown PaddleOCR state: ${String(state)}`);
  const jsonUrl = payload?.data?.resultUrl?.jsonUrl;
  if (typeof jsonUrl !== "string" || !jsonUrl) {
    throw new Error("PaddleOCR result URL is missing");
  }
  const result = await fetch(jsonUrl, { signal: AbortSignal.timeout(20_000) });
  if (!result.ok) throw new Error(`PaddleOCR result HTTP ${result.status}`);
  const text = extractPaddleOcrText(await result.text());
  if (!text) throw new Error("PaddleOCR returned no text");
  return { state: "done", text };
}
