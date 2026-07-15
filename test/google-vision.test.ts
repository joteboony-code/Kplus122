import { afterEach, describe, expect, it, vi } from "vitest";
import { googleVisionOcr } from "../src/google-vision";

describe("Google Vision OCR", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the API key in a header instead of the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      responses: [{ fullTextAnnotation: { text: "K+\nAMT THB 1.22" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await googleVisionOcr(new Uint8Array([1, 2, 3]), "fake-test-key");

    expect(text).toBe("K+\nAMT THB 1.22");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vision.googleapis.com/v1/images:annotate");
    expect(url).not.toContain("fake-test-key");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "fake-test-key" });
  });

  it("produces valid Base64 for images larger than one chunk", async () => {
    const image = new Uint8Array(70_001);
    for (let index = 0; index < image.length; index += 1) image[index] = index % 251;
    let encoded = "";
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        requests: Array<{ image: { content: string } }>;
      };
      encoded = body.requests[0].image.content;
      return new Response(JSON.stringify({ responses: [{}] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await googleVisionOcr(image, "fake-test-key");

    const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    expect(decoded).toEqual(image);
  });
});
