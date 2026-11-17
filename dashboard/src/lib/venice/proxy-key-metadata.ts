// One safe way to change a managed inference key's `metadata`.
//
// Several per-agent settings live side by side in that one jsonb column (the
// wallet a key bills, its daily spend limit, "private models only"). Each
// writer used to read the whole object and write the whole object back, so
// two writers a few milliseconds apart could drop each other's field: a
// spend-limit stamp written from the request path could silently undo a
// privacy setting the owner had just saved.
//
// Every writer goes through here instead. It reads the row, applies the
// change to the metadata it just read, and writes only if the row has not
// changed since (compare-and-set on `updated_at`, which the table's trigger
// bumps on every update). A lost race is retried on fresh data.

type QueryError = { code?: string; message?: string } | null;

type ReadChain = {
  select: (columns: string) => ReadChain;
  eq: (column: string, value: unknown) => ReadChain;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
};

type WriteChain = {
  update: (patch: Record<string, unknown>) => WriteChain;
  eq: (column: string, value: unknown) => WriteChain;
  select: (columns: string) => PromiseLike<{ data: unknown; error: QueryError }>;
};

type SupabaseLike = { from: (table: string) => unknown };

const TABLE = "managed_venice_proxy_keys";
const MAX_ATTEMPTS = 5;

export type ProxyKeyMetadata = Record<string, unknown>;

export class ProxyKeyMetadataConflictError extends Error {
  constructor() {
    super("This setting changed while it was being saved. Try again.");
    this.name = "ProxyKeyMetadataConflictError";
  }
}

function asMetadata(value: unknown): ProxyKeyMetadata {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ProxyKeyMetadata) : {};
}

/**
 * Apply `change` to one key's metadata and save it, without losing a change
 * another writer made in between. `change` gets the metadata as it is now and
 * returns the whole object to store (keep the fields it does not own).
 *
 * Returns the stored metadata, or null when the key does not exist or is not
 * this user's. Throws when the read or write fails, or when the row kept
 * changing for every attempt.
 */
export async function updateManagedVeniceProxyKeyMetadata(
  client: SupabaseLike,
  params: { userId: string; proxyKeyId: string },
  change: (current: ProxyKeyMetadata) => ProxyKeyMetadata
): Promise<ProxyKeyMetadata | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const read = await (client.from(TABLE) as ReadChain)
      .select("id, metadata, updated_at")
      .eq("id", params.proxyKeyId)
      .eq("user_id", params.userId)
      .maybeSingle();
    if (read.error) throw new Error(read.error.message || "Failed to read the managed inference key");
    if (!read.data) return null;
    const row = read.data as { metadata?: unknown; updated_at?: unknown };
    const next = change(asMetadata(row.metadata));

    let write = (client.from(TABLE) as WriteChain)
      .update({ metadata: next })
      .eq("id", params.proxyKeyId)
      .eq("user_id", params.userId);
    // Every stored row has updated_at (NOT NULL). Only a row that somehow has
    // none is written without the guard.
    if (typeof row.updated_at === "string" && row.updated_at) {
      write = write.eq("updated_at", row.updated_at);
    }
    const written = await write.select("id");
    if (written.error) throw new Error(written.error.message || "Failed to save the managed inference key setting");
    if (Array.isArray(written.data) && written.data.length > 0) return next;
    // No row matched: something else updated the key first. Read again.
  }
  throw new ProxyKeyMetadataConflictError();
}
