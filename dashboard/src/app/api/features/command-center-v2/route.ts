import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { isCommandCenterV2EnabledForUser } from "@/lib/command-center/v2-gate";

const ROUTE = "/api/features/command-center-v2";

export async function GET() {
  let userIdForLog: string | null = null;

  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;

    if (!userId) {
      return apiSuccess({ enabled: false });
    }

    const user = await currentUser();
    const enabled = isCommandCenterV2EnabledForUser({
      id: userId,
      primaryEmailAddress: user?.primaryEmailAddress
        ? { emailAddress: user.primaryEmailAddress.emailAddress }
        : null,
      emailAddresses:
        user?.emailAddresses?.map((email) => ({
          emailAddress: email.emailAddress,
        })) || [],
    });

    return apiSuccess({ enabled });
  } catch (error) {
    return apiError(
      "Failed to load Command Center feature flag.",
      500,
      {
        failureType: "command_center_v2_gate_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "features/command-center-v2",
        route: ROUTE,
        method: "GET",
        userId: userIdForLog,
        failureType: "command_center_v2_gate_failed",
        cause: error,
      }
    );
  }
}
