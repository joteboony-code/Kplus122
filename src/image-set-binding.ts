const IMAGE_SET_BINDING_TTL_SECONDS = 30 * 60;

interface ImageSetBindingRow {
  reference_code: string;
}

function validReference(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{8}$/.test(value);
}

export async function getImageSetReference(
  db: D1Database,
  conversationId: string,
  senderUserId: string,
  imageSetId: string,
): Promise<string | undefined> {
  const row = await db.prepare(`SELECT reference_code
      FROM image_set_bindings
      WHERE conversation_id=? AND sender_user_id=? AND image_set_id=?
        AND expires_at>unixepoch()`)
    .bind(conversationId, senderUserId, imageSetId)
    .first<ImageSetBindingRow>();
  return validReference(row?.reference_code) ? row.reference_code : undefined;
}

/**
 * Bind an album once. INSERT OR IGNORE makes the first image authoritative;
 * later webhook retries cannot move the same album to another TID.
 */
export async function bindImageSetReference(
  db: D1Database,
  conversationId: string,
  senderUserId: string,
  imageSetId: string,
  referenceCode: string,
): Promise<string | undefined> {
  if (!validReference(referenceCode)) return undefined;
  await db.prepare(`DELETE FROM image_set_bindings
      WHERE conversation_id=? AND sender_user_id=? AND image_set_id=?
        AND expires_at<=unixepoch()`)
    .bind(conversationId, senderUserId, imageSetId)
    .run();
  await db.prepare(`INSERT OR IGNORE INTO image_set_bindings(
      conversation_id,sender_user_id,image_set_id,reference_code,expires_at
    ) VALUES(?,?,?,?,unixepoch()+?)`)
    .bind(
      conversationId,
      senderUserId,
      imageSetId,
      referenceCode,
      IMAGE_SET_BINDING_TTL_SECONDS,
    )
    .run();
  return getImageSetReference(db, conversationId, senderUserId, imageSetId);
}

export async function purgeExpiredImageSetBindings(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "DELETE FROM image_set_bindings WHERE expires_at<=unixepoch()",
  ).run();
  return result.meta.changes ?? 0;
}

export { IMAGE_SET_BINDING_TTL_SECONDS };
