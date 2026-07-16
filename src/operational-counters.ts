import { DurableObject } from "cloudflare:workers";

export interface CounterIncrementResult {
  accepted: boolean;
  value: number;
}

export class OperationalCounterCoordinator extends DurableObject<Env> {
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

  async setAtLeast(name: string, minimum: number): Promise<number> {
    const key = `counter:${name}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    const value = Math.max(current, minimum);
    if (value !== current) await this.ctx.storage.put(key, value);
    return value;
  }
}

export type OperationalCounterNamespace =
  DurableObjectNamespace<OperationalCounterCoordinator>;
