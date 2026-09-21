// Account-level shared memory (Wave 5.1) — read + write the user-controlled
// blob that is folded read-only into every NEW Hivra box's USER.md at bootstrap.
//
// GET  → { content }   the caller's current shared memory ("" if none)
// PUT  → { content }   upsert the blob (trimmed + clamped server-side), echo it back
// POST → identical to PUT (clients that can't easily send PUT)
//
// Clerk-authed and account-scoped (keyed on userId); all storage goes through
// the server-only account-memory lib (supabaseAdmin). This is orthogonal to the
// per-instance BYO memory providers in lib/instance-settings.ts — do not touch
// those here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getAccountMemory, setAccountMemory } from "@/lib/account-memory";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const content = await getAccountMemory(userId);
    return apiSuccess({ content });
  } catch (err) {
    return handleApiError(err);
  }
}

async function save(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  const content = (body as { content?: unknown })?.content;
  if (typeof content !== "string") {
    return apiError("`content` must be a string", 400);
  }

  await setAccountMemory(userId, content);
  // Echo back what was actually stored (trimmed + clamped) so the client UI
  // reflects the canonical value without a follow-up GET.
  const stored = await getAccountMemory(userId);
  return apiSuccess({ content: stored });
}

export async function PUT(req: NextRequest) {
  try {
    return await save(req);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    return await save(req);
  } catch (err) {
    return handleApiError(err);
  }
}
