// Shared helpers for the billing data layer.
//
// NOTE: managed-venice-client.ts and token-holdings.ts deliberately use a
// LOOSER isRecord (no Array.isArray check) for parsing client-side API
// responses — those are intentionally different and are NOT consolidated here.

/**
 * Assert a Supabase client is configured. Generic so each caller keeps its own
 * local `SupabaseLike` type (the param/return type is inferred from the call
 * site). Previously copy-pasted byte-identically into 16 billing modules.
 */
export function requireDb<T>(db: T | null | undefined): T {
  if (!db) {
    throw new Error("Database not configured");
  }
  return db;
}

/** True for a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Normalize an untrusted metadata field to a plain object, defaulting to {}. */
export function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
