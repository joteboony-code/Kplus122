import { afterEach, describe, expect, it, vi } from "vitest";
import { ocrSpaceOcr } from "../src/ocr-space";
import {
  getOcrSpaceUsage,
  hasOcrSpaceCapacity,
  markOcrSpaceQuotaExhausted,
  recordOcrSpaceRequest,
} from "../src/ocr-space-usage";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) => {
      values.set(key, String(value));
    },
  } as unknown as KVNamespace;
}

describe("OCR.space", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends receipt-oriented options and returns combined text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ParsedResults: [
        { ParsedText: "KPLUS\nAMT THB 1.22" },
        { ParsedText: "VOID THB -1.22" },
      ],
      IsErroredOnProcessing: false,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await ocrSpaceOcr(new Uint8Array([1, 2, 3]), "ocr-test-key");

    expect(text).toMatchObject({
      status: "success",
      text: "KPLUS\nAMT THB 1.22\nVOID THB -1.22",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.ocr.space/parse/image");
    expect(init.headers).toMatchObject({ apikey: "ocr-test-key" });
    const form = init.body as FormData;
    expect(form.get("OCREngine")).toBe("2");
    expect(form.get("isTable")).toBe("true");
    expect(form.get("scale")).toBe("true");
    expect(form.get("detectOrientation")).toBe("true");
    expect(form.get("base64Image")).toBe("data:image/jpeg;base64,AQID");
  });

  it("recognizes provider quota exhaustion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("", { status: 429 }),
    ));
    await expect(ocrSpaceOcr(new Uint8Array([1]), "key")).resolves.toMatchObject({
      status: "quota-exhausted",
    });
  });
});

describe("OCR.space daily usage", () => {
  it("counts by Bangkok calendar day", async () => {
    const kv = memoryKv();
    const dayOne = new Date("2026-07-15T16:59:00.000Z");
    const dayTwo = new Date("2026-07-15T17:01:00.000Z");

    expect(await recordOcrSpaceRequest(kv, dayOne)).toBe(1);
    expect(await getOcrSpaceUsage(kv, dayOne)).toBe(1);
    expect(await getOcrSpaceUsage(kv, dayTwo)).toBe(0);
  });

  it("stops after the provider reports its daily quota exhausted", async () => {
    const kv = memoryKv();
    await markOcrSpaceQuotaExhausted(kv);
    expect(await getOcrSpaceUsage(kv)).toBe(500);
    expect(await hasOcrSpaceCapacity(kv)).toBe(false);
  });
});
