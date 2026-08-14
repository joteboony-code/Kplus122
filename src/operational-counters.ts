import { DurableObject } from "cloudflare:workers";

export interface CounterIncrementResult {
  accepted: boolean;
  value: number;
}

export class OperationalCounterCoordinator extends DurableObject<Env> {
  private readonly activeImageCountKey = "active-image-count";

  async get(name: string): Promise<number> {
    return (await this.ctx.storage.get<number>(`counter:${name}`)) ?? 0;
  }

  async getMany(names: string[]): Promise<Record<string, number>> {
    const keys = names.map((name) => `counter:${name}`);
    const stored = await this.ctx.storage.get<number>(keys);
    return Object.fromEntries(
      names.map((name) => [name, stored.get(`counter:${name}`) ?? 0]),
    );
  }

  async increment(name: string, limit?: number): Promise<CounterIncrementResult> {
    const key = `counter:${name}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (limit !== undefined && current >= limit) {
      return { accepted: false, value: current };
    }

    const value = current + 1;
    await this.ctx.storage.put(key, value);
    return { accepted: true, value };
  }

  async incrementBy(name: string, amount: number): Promise<CounterIncrementResult> {
    const delta = Math.max(0, Math.floor(amount));
    const key = `counter:${name}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    const value = current + delta;
    if (value !== current) await this.ctx.storage.put(key, value);
    return { accepted: true, value };
  }

  async setAtLeast(name: string, minimum: number): Promise<number> {
    const key = `counter:${name}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    const value = Math.max(current, minimum);
    if (value !== current) await this.ctx.storage.put(key, value);
    return value;
  }

  /** Claim an image for the inspection lifecycle. Idempotent per message id. */
  async claimActiveImage(messageId: string): Promise<number> {
    const key = `active-image:${messageId}`;
    if (await this.ctx.storage.get<boolean>(key)) {
      return (await this.ctx.storage.get<number>(this.activeImageCountKey)) ?? 0;
    }
    const current = (await this.ctx.storage.get<number>(this.activeImageCountKey)) ?? 0;
    await this.ctx.storage.put(key, true);
    await this.ctx.storage.put(this.activeImageCountKey, current + 1);
    return current + 1;
  }

  /** Release an image once its inspection has reached a terminal state. */
  async releaseActiveImage(messageId: string): Promise<number> {
    const key = `active-image:${messageId}`;
    if (!(await this.ctx.storage.get<boolean>(key))) {
      return (await this.ctx.storage.get<number>(this.activeImageCountKey)) ?? 0;
    }
    const current = (await this.ctx.storage.get<number>(this.activeImageCountKey)) ?? 0;
    const value = Math.max(0, current - 1);
    await this.ctx.storage.delete(key);
    await this.ctx.storage.put(this.activeImageCountKey, value);
    return value;
  }

  async getActiveImageCount(): Promise<number> {
    return (await this.ctx.storage.get<number>(this.activeImageCountKey)) ?? 0;
  }
}

export type OperationalCounterNamespace =
  DurableObjectNamespace<OperationalCounterCoordinator>;
