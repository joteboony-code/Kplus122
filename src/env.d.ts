interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_VISION_API_KEY?: string;
  OCR_SPACE_API_KEY?: string;
  PADDLEOCR_TOKEN?: string;
  PADDLEOCR_MODEL?: string;
  CONTROL_PASSWORD: string;
  CASTLE_SERVICE: import("./service-look").CastleServiceBinding;
  CONTROL_DB: D1Database;
  OPERATIONAL_COUNTERS: DurableObjectNamespace<
    import("./operational-counters").OperationalCounterCoordinator
  >;
  PROCESSING_FORCE_DISABLED?: string;
  LINE_WEBHOOKS: Queue<import("./types").LineWebhookQueueJob>;
  IMAGE_QUEUE: Queue<
    import("./types").ImageJob |
    import("./types").RoundFinalizeJob |
    import("./types").PaddlePollJob
  >;
  OCR_FALLBACK_QUEUE: Queue<import("./types").OcrFallbackJob>;
}
