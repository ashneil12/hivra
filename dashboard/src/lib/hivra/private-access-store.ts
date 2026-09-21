import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

/** Clear only the exact owner's persisted private-access authority after the
 * provider is already proven absent. Guest/tailnet teardown is handled before
 * provider deletion; this function cannot claim external node removal. */
export async function clearHivraPrivateAccessAfterDelete(input: {
  userId: string;
  agentId: string;
  operationId: string;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin.rpc("clear_hivra_private_access_after_delete", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
  });
  return !error && data === true;
}
