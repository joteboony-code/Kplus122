export interface OcrSpaceResult {
  status: "success" | "quota-exhausted" | "error";
  text: string;
  error?: string;
}

interface OcrSpaceResponse {
  ParsedResults?: Array<{
    ParsedText?: string;
    ErrorMessage?: string;
  }>;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x6000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

function errorText(result: OcrSpaceResponse): string {
  const topLevel = Array.isArray(result.ErrorMessage)
    ? result.ErrorMessage.join("; ")
    : result.ErrorMessage ?? "";
  const pageErrors = (result.ParsedResults ?? [])
    .map((page) => page.ErrorMessage ?? "")
    .filter(Boolean)
    .join("; ");
  return [topLevel, pageErrors].filter(Boolean).join("; ");
}

function isQuotaError(message: string): boolean {
  return /(?:quota|rate\s*limit|maximum\s+number|requests?\s+per\s+day)/i.test(message);
}

export async function ocrSpaceOcr(
  image: Uint8Array,
  apiKey: string,
): Promise<OcrSpaceResult> {
  const form = new FormData();
  form.set("base64Image", `data:image/jpeg;base64,${bytesToBase64(image)}`);
  form.set("language", "eng");
  form.set("isOverlayRequired", "false");
  form.set("detectOrientation", "true");
  form.set("scale", "true");
  form.set("isTable", "true");
  form.set("OCREngine", "2");

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) {
    return { status: "quota-exhausted", text: "", error: "HTTP 429" };
  }
  if (!response.ok) {
    return {
      status: "error",
      text: "",
      error: `OCR.space request failed with ${response.status}`,
    };
  }

  const result = (await response.json()) as OcrSpaceResponse;
  const error = errorText(result);
  if (result.IsErroredOnProcessing || error) {
    return {
      status: isQuotaError(error) ? "quota-exhausted" : "error",
      text: "",
      error: error || "OCR.space processing failed",
    };
  }

  return {
    status: "success",
    text: (result.ParsedResults ?? [])
      .map((page) => page.ParsedText ?? "")
      .join("\n")
      .trim(),
  };
}
