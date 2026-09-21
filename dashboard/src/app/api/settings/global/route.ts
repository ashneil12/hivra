import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";

const GlobalSettingsSchema = z.object({
  sessionExpiryHours: z.number().min(1).max(720).optional(),
  memoryContextLimit: z.number().min(500).max(10000).optional(),
  userContextLimit: z.number().min(500).max(10000).optional(),
});

export async function POST(req: Request) {
  try {
    const authObj = await auth();
    const userId = authObj.userId;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "settings_global_post",
      userId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) {
      return rateLimitError;
    }

    const body = await req.json();
    const result = GlobalSettingsSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ error: "Invalid payload", details: result.error.errors }, { status: 400 });
    }

    const { sessionExpiryHours, memoryContextLimit, userContextLimit } = result.data;
    
    // We only update what was provided in the payload
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const existingHermesSettings = user.publicMetadata.hermesSettings as Record<string, unknown> || {};

    const nextSettings = {
      ...existingHermesSettings,
    };
    if (sessionExpiryHours !== undefined) nextSettings.sessionExpiryHours = sessionExpiryHours;
    if (memoryContextLimit !== undefined) nextSettings.memoryContextLimit = memoryContextLimit;
    if (userContextLimit !== undefined) nextSettings.userContextLimit = userContextLimit;

    await clerk.users.updateUser(userId, {
      publicMetadata: {
        ...user.publicMetadata,
        hermesSettings: nextSettings
      }
    });

    return NextResponse.json({ success: true, settings: nextSettings });
  } catch {
    return NextResponse.json({ error: "Failed to persist settings" }, { status: 500 });
  }
}
