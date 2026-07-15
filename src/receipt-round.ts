import type { ImageJob } from "./types";

export function shouldReplyToIndividualFailure(job: ImageJob): boolean {
  return !job.imageSetId;
}
