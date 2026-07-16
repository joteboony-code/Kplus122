interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_VISION_API_KEY?: string;
  OCR_SPACE_API_KEY?: string;
  CONTROL_PASSWORD: string;
  CONTROL_DB: D1Database;
  OPERATIONAL_COUNTERS: DurableObjectNamespace<
    import("./operational-counters").OperationalCounterCoordinator
  >;
  PROCESSING_FORCE_DISABLED?: string;
}
