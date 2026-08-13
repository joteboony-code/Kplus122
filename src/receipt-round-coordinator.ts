import { DurableObject } from "cloudflare:workers";
import {
  claimRoundFailure,
  claimRoundPass,
  claimRoundStock,
  completeRoundAfterFailure,
  completeRoundFinalization,
  completeRoundAfterPass,
  completeRoundImage,
  completeRoundImageAndGetFailureFinalizer,
  completeRoundReplyToken,
  completeRoundStock,
  completePendingRoundFailureFinalization,
  finalizeRound,
  finalizePendingRoundFailure,
  recordPendingRoundFailure,
  registerRoundImage,
  recordRoundReplyToken,
  recordRoundActivity,
  releaseRoundFailure,
  releasePendingRoundFailureFinalization,
  releaseRoundFinalization,
  releaseRoundPass,
  releaseRoundStock,
  selectLatestRoundReplyToken,
  type PendingFailureFinalization,
  type PendingFailureRecord,
  type RoundEvidence,
  type RoundFinalization,
  type RoundReplyTokenSelection,
} from "./receipt-round";
import type { StateStore } from "./state-store";
import type { FailureFinalizeJob, ImageJob, RoundFinalizeJob } from "./types";

const STATE_KEY_PREFIX = "round:";

export class ReceiptRoundCoordinator extends DurableObject<Env> {
  private transactionState(transaction: DurableObjectTransaction): StateStore {
    return {
      get: async (key) =>
        (await transaction.get<string>(`${STATE_KEY_PREFIX}${key}`)) ?? null,
      put: async (key, value) => {
        await transaction.put(`${STATE_KEY_PREFIX}${key}`, value);
      },
      delete: async (key) => {
        await transaction.delete(`${STATE_KEY_PREFIX}${key}`);
      },
    };
  }

  async recordActivity(
    job: ImageJob,
    evidence: RoundEvidence | undefined,
    generation: string,
  ): Promise<RoundFinalizeJob | null> {
    const activityAt = typeof job.timestamp === "number" &&
      Number.isFinite(job.timestamp) &&
      job.timestamp > 0
      ? Math.min(job.timestamp, Date.now())
      : Date.now();
    return this.ctx.storage.transaction((transaction) =>
      recordRoundActivity(
        job,
        evidence,
        this.transactionState(transaction),
        activityAt,
        generation,
      ));
  }

  async registerImage(
    job: ImageJob,
    generation: string,
  ): Promise<RoundFinalizeJob | null> {
    const activityAt = typeof job.timestamp === "number" &&
      Number.isFinite(job.timestamp) &&
      job.timestamp > 0
      ? Math.min(job.timestamp, Date.now())
      : Date.now();
    return this.ctx.storage.transaction((transaction) =>
      registerRoundImage(
        job,
        this.transactionState(transaction),
        activityAt,
        generation,
      ));
  }

  async completeImage(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundImage(job, this.transactionState(transaction)));
  }

  async completeImageAndGetFailureFinalizer(
    job: ImageJob,
  ): Promise<FailureFinalizeJob | null> {
    return this.ctx.storage.transaction((transaction) =>
      completeRoundImageAndGetFailureFinalizer(job, this.transactionState(transaction)));
  }

  async recordPendingFailure(
    job: ImageJob,
    evidence: RoundEvidence,
    generation: string,
  ): Promise<PendingFailureRecord | null> {
    return this.ctx.storage.transaction((transaction) =>
      recordPendingRoundFailure(
        job,
        evidence,
        this.transactionState(transaction),
        Date.now(),
        generation,
      ));
  }

  async recordReplyToken(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      recordRoundReplyToken(job, this.transactionState(transaction)));
  }

  async selectReplyToken(job: ImageJob): Promise<RoundReplyTokenSelection | null> {
    return this.ctx.storage.transaction((transaction) =>
      selectLatestRoundReplyToken(job, this.transactionState(transaction)));
  }

  async completeReplyToken(job: ImageJob, sourceMessageId: string): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundReplyToken(job, sourceMessageId, this.transactionState(transaction)));
  }

  async completeAfterPass(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundAfterPass(job, this.transactionState(transaction)));
  }

  async completeAfterFailure(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundAfterFailure(job, this.transactionState(transaction)));
  }

  async claimPass(job: ImageJob) {
    return this.ctx.storage.transaction((transaction) =>
      claimRoundPass(job, this.transactionState(transaction)));
  }

  async claimFailure(job: ImageJob) {
    return this.ctx.storage.transaction((transaction) =>
      claimRoundFailure(job, this.transactionState(transaction)));
  }

  async releasePass(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      releaseRoundPass(job, this.transactionState(transaction)));
  }

  async releaseFailure(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      releaseRoundFailure(job, this.transactionState(transaction)));
  }

  async claimStock(job: ImageJob) {
    return this.ctx.storage.transaction((transaction) =>
      claimRoundStock(job, this.transactionState(transaction)));
  }

  async releaseStock(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      releaseRoundStock(job, this.transactionState(transaction)));
  }

  async completeStock(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundStock(job, this.transactionState(transaction)));
  }

  async finalize(job: RoundFinalizeJob): Promise<RoundFinalization> {
    return this.ctx.storage.transaction((transaction) =>
      finalizeRound(job, this.transactionState(transaction)));
  }

  async finalizeFailure(job: FailureFinalizeJob): Promise<PendingFailureFinalization> {
    return this.ctx.storage.transaction((transaction) =>
      finalizePendingRoundFailure(job, this.transactionState(transaction)));
  }

  async releaseFailureFinalization(job: FailureFinalizeJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      releasePendingRoundFailureFinalization(job, this.transactionState(transaction)));
  }

  async completeFailureFinalization(job: FailureFinalizeJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completePendingRoundFailureFinalization(job, this.transactionState(transaction)));
  }


  async releaseFinalization(job: RoundFinalizeJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      releaseRoundFinalization(job, this.transactionState(transaction)));
  }

  async completeFinalization(job: RoundFinalizeJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundFinalization(job, this.transactionState(transaction)));
  }
}
