export const runtime = "nodejs";

// Each instance teardown is a real Proxmox/Hetzner destroy through the
// existing DELETE handler; give the whole account sweep the same budget the
// web deletion path gets.
export const maxDuration = 300;

import { NextRequest } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
// The EXISTING per-instance deletion path — the route handler owns every
// teardown guard (zombie-VM refusal, released-handle short-circuits, DNS
// cleanup, VMID release). We invoke it directly rather than reimplementing
// any of it; Clerk's auth() inside resolves from this request's ambient
// context, so ownership checks run exactly as they do for the web client.
import { DELETE as deleteInstanceRoute } from "@/app/api/instances/[id]/route";

/**
 * DELETE /api/mobile/account — in-app account deletion (iOS Phase 2; App
 * Store guideline 5.1.1(v) requires it once the app offers sign-up).
 *
 * Guard-rails:
 *   - Explicit confirm token in the body (the app shows the type-to-confirm
 *     screen); no token, no deletion.
 *   - Instances are torn down FIRST via the existing DELETE
 *     /api/instances/[id] path. If ANY teardown fails, the Clerk user is NOT
 *     deleted and the response lists what failed — never strand live VMs
 *     billing against a deleted account. The operation is idempotent: retry
 *     after a partial failure re-runs only what's left.
 *   - Clerk deleteUser runs last, after device tokens are removed.
 *
 * Apple-sub note for the app's UI (Apple's standard pattern): deleting the
 * account does NOT cancel an App Store subscription — the user must cancel in
 * iOS Settings. Echoed in the response so the app can render the reminder.
 */

const LOG_SOURCE = "mobile-account";
const ROUTE = "/api/mobile/account";

// NOTE: not exported — Next.js route modules may only export handlers/config.
const ACCOUNT_DELETE_CONFIRM_TOKEN = "DELETE_MY_ACCOUNT";

const DeleteAccountSchema = z.object({
  confirm: z.string(),
});

interface InstanceIdRow {
  id: string;
  name: string | null;
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const json = await request.json().catch(() => null);
    const parsed = DeleteAccountSchema.safeParse(json);
    if (!parsed.success || parsed.data.confirm !== ACCOUNT_DELETE_CONFIRM_TOKEN) {
      return apiError(
        `Confirm deletion by sending { "confirm": "${ACCOUNT_DELETE_CONFIRM_TOKEN}" }.`,
        400,
        undefined,
        { failureType: "account_delete_confirmation_required" },
        {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "account_delete_confirmation_required",
          userId,
        }
      );
    }

    // Same visibility filter as the instances list: rows that are terminal on
    // BOTH signals are already gone and need no teardown.
    const { data: instanceRows, error: listError } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .neq("lifecycle_state", "deleted")
      .returns<InstanceIdRow[]>();
    if (listError) {
      return apiError("Failed to load your agents", 500, listError, undefined, {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "account_delete_instance_list_failed",
        userId,
      });
    }

    const deletedInstances: string[] = [];
    const failedInstances: Array<{ id: string; status: number }> = [];

    for (const instance of instanceRows ?? []) {
      try {
        // The [id] DELETE requires the typed-id confirmation in its body —
        // supply it exactly as the web's type-to-confirm modal does.
        const deleteRequest = new NextRequest(
          `http://mobile.internal/api/instances/${instance.id}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmation: instance.id }),
          }
        );
        const response = await deleteInstanceRoute(deleteRequest, {
          params: Promise.resolve({ id: instance.id }),
        });
        if (response.ok) {
          deletedInstances.push(instance.id);
        } else {
          failedInstances.push({ id: instance.id, status: response.status });
        }
      } catch (err) {
        failedInstances.push({ id: instance.id, status: 500 });
        log.error("account deletion: instance teardown threw", err, {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "account_delete_instance_teardown_failed",
          userId,
          instanceId: instance.id,
        });
      }
    }

    if (failedInstances.length > 0) {
      // Refuse to delete the account while any agent teardown failed — the
      // existing per-instance guards refuse precisely when a live VM might be
      // left behind, and deleting the Clerk user now would orphan it.
      return apiError(
        "Some of your agents could not be removed. Nothing was lost — please try again, or contact support if this keeps happening.",
        502,
        { failedInstances },
        {
          failureType: "account_delete_instances_failed",
          deletedInstances,
          failedInstanceIds: failedInstances.map((f) => f.id),
        },
        {
          source: LOG_SOURCE,
          route: ROUTE,
          failureType: "account_delete_instances_failed",
          userId,
        }
      );
    }

    // Push tokens: hard-delete (the account is going away; nothing should
    // ever notify this user again). Best-effort — a leftover disabled row
    // must not block the account deletion.
    const { error: tokenError } = await supabaseAdmin
      .from("device_tokens")
      .delete()
      .eq("user_id", userId);
    if (tokenError) {
      log.warn("account deletion: device token cleanup failed (continuing)", {
        source: LOG_SOURCE,
        route: ROUTE,
        failureType: "account_delete_device_tokens_failed",
        userId,
        errorMessage: tokenError.message,
      });
    }

    // Clerk user last — after this the session is gone and nothing below the
    // response can be retried under the same identity.
    const clerk = await clerkClient();
    await clerk.users.deleteUser(userId);

    log.info("mobile account deleted", {
      source: LOG_SOURCE,
      route: ROUTE,
      userId,
      deletedInstanceCount: deletedInstances.length,
    });

    return apiSuccess({
      accountDeleted: true,
      deletedInstances,
      deletedInstanceCount: deletedInstances.length,
      // Apple's standard pattern: account deletion never cancels App Store
      // billing — the app surfaces this line verbatim.
      note: "If you subscribed through the App Store, cancel the subscription in your iOS Settings — deleting your account does not stop Apple billing.",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
