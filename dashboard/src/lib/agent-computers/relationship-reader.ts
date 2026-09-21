import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { CanonicalRelationshipSnapshotSchema, type CanonicalRelationshipSnapshot } from "./relationship-snapshot";

interface RelationshipDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export class CanonicalRelationshipReadError extends Error {
  constructor() { super("Computer relationships are unavailable. No relationship state was changed."); }
}

/** Call only with the server-authenticated owner, never a request body owner.
 * A missing migration or unsupported response is an error, not an empty list.
 */
export function createCanonicalRelationshipReader(db: RelationshipDatabase | null = supabaseAdmin) {
  return {
    async read(ownerId: string, computerId: string): Promise<CanonicalRelationshipSnapshot | null> {
      if (!db || !z.string().min(1).max(256).safeParse(ownerId).success || !z.string().uuid().safeParse(computerId).success) {
        throw new CanonicalRelationshipReadError();
      }
      let response: { data: unknown; error: unknown };
      try {
        response = await db.rpc("read_hivra_canonical_computer_relationships", { p_owner: ownerId, p_computer_id: computerId });
      } catch { throw new CanonicalRelationshipReadError(); }
      if (!response || typeof response !== "object" || Array.isArray(response)
        || !Object.prototype.hasOwnProperty.call(response, "data")
        || !Object.prototype.hasOwnProperty.call(response, "error")
        || response.error !== null) throw new CanonicalRelationshipReadError();
      if (response.data === null) return null;
      const result = CanonicalRelationshipSnapshotSchema.safeParse(response.data);
      if (!result.success || result.data.ownerId !== ownerId || result.data.computerId !== computerId) {
        throw new CanonicalRelationshipReadError();
      }
      return result.data;
    },
  };
}
