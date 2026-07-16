export interface StateStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export function d1StateStore(db: D1Database): StateStore {
  return {
    async get(key) {
      const row = await db
        .prepare(`SELECT value FROM control_state
          WHERE key = ? AND (expires_at IS NULL OR expires_at > unixepoch())`)
        .bind(key)
        .first<{ value: string }>();
      return row?.value ?? null;
    },

    async put(key, value, options) {
      const expirationTtl = options?.expirationTtl;
      const expiresAt = expirationTtl
        ? Math.floor(Date.now() / 1000) + expirationTtl
        : null;
      await db
        .prepare(`INSERT INTO control_state (key, value, updated_at, expires_at)
          VALUES (?, ?, unixepoch(), ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at`)
        .bind(key, value, expiresAt)
        .run();
    },

    async delete(key) {
      await db.prepare("DELETE FROM control_state WHERE key = ?").bind(key).run();
    },
  };
}

export async function purgeExpiredState(
  db: D1Database,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM control_state
      WHERE expires_at IS NOT NULL AND expires_at <= ?`)
    .bind(nowSeconds)
    .run();
  return result.meta.changes;
}
