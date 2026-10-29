import type { NextRequest } from "next/server";

/**
 * Bearer key from an `Authorization: Bearer <key>` header, or null when the
 * header is missing, is not a bearer header, or carries an empty key.
 * Shared by the managed-venice /v1 proxy routes.
 */
export function readBearerKey(req: NextRequest) {
  const header = req.headers.get("authorization")?.trim() || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}
