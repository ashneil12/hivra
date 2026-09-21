// Manually trigger applyLiveUpdate for a single instance.
//
// This is what the dashboard's "Update Now" button does (POST
// /api/instances/:id with action=update), but bypassing Clerk auth so it
// works for instances whose owner has been deleted from Clerk — those
// silently get skipped by auto-update paths (see migration-gap task spawned
// 2026-05-01). Falls back to globalSettings={} on Clerk Not Found.
//
// Usage:
//   npm run instance:update -- <instance-id>
//
// Or directly:
//   TS_NODE_TRANSPILE_ONLY=true \
//   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
//   node -r ./scripts/register-server-only-noop.cjs \
//        -r ts-node/register/transpile-only \
//        -r tsconfig-paths/register \
//        scripts/trigger-instance-update.ts <instance-id>
//
// Uses `applyLiveUpdate` so it picks the backend-aware path (WebUI bootstrap
// for `backend === "webui"`).

import path from "path";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/nextjs/server";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  applyLiveUpdate,
  resolveInstanceIpv4,
} from "../src/lib/services/instance-orchestrator";
import { extractGlobalHermesSettings } from "../src/lib/instance-settings";

async function main() {
  const instanceId = process.argv[2] || process.env.INSTANCE_ID;
  if (!instanceId) {
    console.error("Usage: trigger-instance-update.ts <instance-id>");
    console.error("Or set INSTANCE_ID in the environment.");
    process.exit(1);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  console.log(`[trigger-update] fetching instance row ${instanceId}`);
  const { data: instance, error } = await supabase
    .from("hermes_instances")
    .select("*")
    .eq("id", instanceId)
    .single();
  if (error || !instance) {
    console.error("[trigger-update] instance not found", error);
    process.exit(1);
  }

  console.log(
    `[trigger-update] name=${instance.name} status=${instance.status} backend=${instance.backend} provider=${instance.provider} user=${instance.user_id}`
  );

  let globalSettings: Record<string, unknown> = {};
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(instance.user_id);
    globalSettings = extractGlobalHermesSettings(user.publicMetadata);
    console.log(
      `[trigger-update] loaded globalSettings keys: ${
        Object.keys(globalSettings).join(", ") || "(none)"
      }`
    );
  } catch (e) {
    console.warn(
      `[trigger-update] couldn't fetch clerk publicMetadata, defaulting to {}: ${
        (e as Error).message
      }`
    );
  }

  const ipv4 = await resolveInstanceIpv4(instance, supabase);
  console.log(`[trigger-update] resolved ipv4=${ipv4}`);

  console.log(`[trigger-update] calling applyLiveUpdate...`);
  const result = await applyLiveUpdate(instance, ipv4, globalSettings, supabase);
  console.log(
    `[trigger-update] applyLiveUpdate returned:`,
    JSON.stringify(result, null, 2)
  );

  if (!result.applied) {
    console.error("[trigger-update] update NOT applied");
    process.exit(2);
  }
  console.log(
    `[trigger-update] update launched. Wait ~60-120s, then verify the container.`
  );
}

main().catch((e) => {
  console.error("[trigger-update] fatal:", e);
  process.exit(99);
});
