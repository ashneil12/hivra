import { createClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/nextjs/server";
import {
  applyLiveUpdate,
  resolveInstanceIpv4,
} from "../src/lib/services/instance-orchestrator";
import { extractGlobalHermesSettings } from "../src/lib/instance-settings";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const id = process.argv[2] || process.env.INSTANCE_ID;
  if (!id) {
    console.error("Usage: ts-node dashboard/scripts/force-redeploy.ts <instance-id>");
    console.error("Or set INSTANCE_ID in the environment.");
    process.exit(1);
  }

  const { data: instance, error } = await supabase.from("hermes_instances").select("*").eq("id", id).single();
  if (error || !instance) {
    console.error("Not found", error);
    process.exit(1);
  }
  
  let globalSettings: Record<string, unknown> = {};
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(instance.user_id);
    globalSettings = extractGlobalHermesSettings(user.publicMetadata);
  } catch (e) {
    console.warn(
      `[force-redeploy] couldn't fetch Clerk public metadata, defaulting to {}: ${
        (e as Error).message
      }`
    );
  }

  const ipv4 = await resolveInstanceIpv4(instance, supabase);
  console.log(
    `[force-redeploy] launching backend-aware redeploy for backend=${instance.backend ?? "gateway"} ipv4=${ipv4}`
  );
  const result = await applyLiveUpdate(instance, ipv4, globalSettings, supabase);
  console.log("[force-redeploy] result:", JSON.stringify(result, null, 2));

  if (!result.applied) {
    console.error("[force-redeploy] redeploy NOT applied");
    process.exit(2);
  }

  console.log("[force-redeploy] redeploy launched");
}
main();
