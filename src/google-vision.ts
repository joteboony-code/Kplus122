interface GoogleVisionResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    error?: { message?: string };
  }>;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Every non-final chunk must contain a multiple of three bytes. Otherwise,
  // btoa() inserts padding in the middle of the concatenated Base64 payload.
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

export async function googleVisionOcr(
  image: Uint8Array,
  apiKey: string,
): Promise<string> {
  const response = await fetch(
    "https://vision.googleapis.com/v1/images:annotate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: [
          {
            image: { content: bytesToBase64(image) },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["en", "th"] },
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Google Vision request failed with ${response.status}`);
  }

  const result = (await response.json()) as GoogleVisionResponse;
  const annotation = result.responses?.[0];
  if (annotation?.error?.message) {
    throw new Error(`Google Vision error: ${annotation.error.message}`);
  }

  return (
    annotation?.fullTextAnnotation?.text ??
    annotation?.textAnnotations?.[0]?.description ??
    ""
  ).trim();
}
