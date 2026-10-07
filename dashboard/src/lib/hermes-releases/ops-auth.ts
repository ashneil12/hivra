import { auth, currentUser } from "@clerk/nextjs/server";

import { isOpsAdminUser, verifiedPrimaryEmailOf } from "@/lib/ops-access";

export type OpsAdminResult =
  | { ok: true; actor: string }
  | { ok: false; status: 401 | 403; message: string };

/** Clerk session that belongs to a configured ops admin (verified email or user id). */
export async function requireOpsAdmin(): Promise<OpsAdminResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, status: 401, message: "Unauthorized" };
  const user = await currentUser();
  const email = verifiedPrimaryEmailOf(user);
  if (!isOpsAdminUser({ userId, email })) return { ok: false, status: 403, message: "Forbidden" };
  return { ok: true, actor: `ops:${userId}` };
}
