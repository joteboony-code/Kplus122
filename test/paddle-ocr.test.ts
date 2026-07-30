import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractPaddleOcrText,
  pollPaddleOcr,
  submitPaddleOcr,
} from "../src/paddle-ocr";

describe("PaddleOCR", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts text from PaddleOCR JSONL results", () => {
    const jsonl = [
      JSON.stringify({
        result: {
          layoutParsingResults: [{ markdown: { text: "KPLUS" } }],
        },
      }),
      JSON.stringify({
        result: {
          ocrResults: [{ prunedResult: { rec_texts: ["AMT THB 1.22", "SETTLEMENT"] } }],
        },
      }),
    ].join("\n");

    expect(extractPaddleOcrText(jsonl))
      .toBe("KPLUS\nAMT THB 1.22\nSETTLEMENT");
  });

  it("submits an image with the token only in the authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { jobId: "paddle-job-1" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPaddleOcr(
      new Uint8Array([0xff, 0xd8, 0xff]),
      "secret-token",
    )).resolves.toBe("paddle-job-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://paddleocr.aistudio-app.com/api/v2/ocr/jobs");
    expect(url).not.toContain("secret-token");
    expect(init.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });
    expect((init.body as FormData).get("model")).toBe("PaddleOCR-VL-1.6");
  });

  it("polls pending jobs without downloading a result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { state: "running" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollPaddleOcr("job/1", "token"))
      .resolves.toEqual({ state: "pending" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("job%2F1");
  });

  it("downloads and parses a completed job result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          state: "done",
          resultUrl: { jsonUrl: "https://result.example/job.jsonl" },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          result: {
            ocrResults: [{ prunedResult: { recTexts: ["K+", "THB 1.22"] } }],
          },
        }),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollPaddleOcr("job-2", "token")).resolves.toEqual({
      state: "done",
      text: "K+\nTHB 1.22",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
