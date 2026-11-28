import { supabaseAdmin } from "../supabase";
import { parseSleepMode } from "./agent-sleep-policy";
import { agentSleepUiEnabled } from "./agent-sleep-ui";

export async function paidKvmSleepAvailable(): Promise<boolean> {
  if (parseSleepMode(process.env.HIVRA_SLEEP_MODE) !== "on" || !agentSleepUiEnabled() || !supabaseAdmin) return false;

  try {
    const { data, error } = await supabaseAdmin.from("proxmox_hosts")
      .select("id")
      .eq("status", "active")
      .eq("sleep_mode", "on")
      .is("decommissioned_at", null)
      .limit(1)
      .abortSignal(AbortSignal.timeout(1_500));
    return !error && (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
