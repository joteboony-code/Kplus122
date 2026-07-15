import { DurableObject } from "cloudflare:workers";
import {
  completeRoundAfterPass,
  finalizeRound,
  recordRoundActivity,
  type RoundEvidence,
  type RoundFinalization,
} from "./receipt-round";
import type { StateStore } from "./state-store";
import type { ImageJob, RoundFinalizeJob } from "./types";

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
    return this.ctx.storage.transaction((transaction) =>
      recordRoundActivity(
        job,
        evidence,
        this.transactionState(transaction),
        Date.now(),
        generation,
      ));
  }

  async completeAfterPass(job: ImageJob): Promise<void> {
    await this.ctx.storage.transaction((transaction) =>
      completeRoundAfterPass(job, this.transactionState(transaction)));
  }

  async finalize(job: RoundFinalizeJob): Promise<RoundFinalization> {
    return this.ctx.storage.transaction((transaction) =>
      finalizeRound(job, this.transactionState(transaction)));
  }
}
