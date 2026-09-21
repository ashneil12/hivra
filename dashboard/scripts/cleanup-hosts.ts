
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase credentials");
}
const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function cleanup() {
  console.log("Starting cleanup of ghost hosts...");
  
  // Find hosts with no active instances
  const { data: hosts } = await supabaseAdmin.from("hermes_hosts").select("*").neq("status", "deleted");
  
  if (!hosts || hosts.length === 0) {
    console.log("No active hosts found.");
    process.exit(0);
  }

  for (const host of hosts) {
    const { data: instances } = await supabaseAdmin
      .from("hermes_instances")
      .select("id")
      .eq("host_id", host.id)
      .neq("status", "deleted");
      
    if (!instances || instances.length === 0) {
      console.log(`Host ${host.id} has no active instances. Marking as deleted.`);
      await supabaseAdmin.from("hermes_hosts").update({ status: "deleted" }).eq("id", host.id);
    } else {
      console.log(`Host ${host.id} has ${instances.length} active instances.`);
    }
  }
  
  console.log("Cleanup complete.");
  process.exit(0);
}

cleanup().catch(console.error);
