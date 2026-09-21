import { supabaseAdmin } from "@/lib/supabase";

export interface UpsertPoolArgs {
  userId: string;
  /** 'hermesos' (default) | 'workspace_cloud' */
  productSurface?: string;
  subscriptionId?: string | null;
  cpuBudget: number;
  ramBudgetMb: number;
  agentSlots: number;
  /** Phase 5 scheduling weight (0=low..2=high). Defaults 0. */
  priority?: number;
  status?: string;
}

/**
 * Upsert the resource POOL for a (user, product_surface).
 *
 * The pool is the user-level compute budget — total CPU/RAM + agent slots +
 * scheduling priority — that a user spends across separate, isolated agent
 * deployments (architecture lock v1.1: one agent = one VM; NOT a shared VM).
 *
 * Phase 1 writes the pool ALONGSIDE the subscription budget; later phases flip
 * reads to it. Best-effort + logged: a pool-write failure must NOT break billing —
 * the subscription row remains the source of truth until the read-flip.
 */
export async function upsertPool(args: UpsertPoolArgs): Promise<void> {
  const productSurface = args.productSurface ?? "hermesos";
  try {
    if (!supabaseAdmin) return;
    const { error } = await supabaseAdmin.from("pools").upsert(
      {
        user_id: args.userId,
        product_surface: productSurface,
        subscription_id: args.subscriptionId ?? null,
        cpu_budget: args.cpuBudget,
        ram_budget_mb: args.ramBudgetMb,
        agent_slots: args.agentSlots,
        priority: args.priority ?? 0,
        status: args.status ?? "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,product_surface" },
    );
    // eslint-disable-next-line no-console -- Best-effort error log for pool bookkeeping; deliberately stays on console to avoid coupling pool upserts to ops_events.
    if (error) console.error("[pools] upsert error", { userId: args.userId, productSurface, error: error.message });
  } catch (err) {
    // eslint-disable-next-line no-console -- Best-effort error log for pool bookkeeping; see above.
    console.error("[pools] upsert failed", { userId: args.userId, productSurface, err: String(err) });
  }
}

/**
 * Resolve the user's pool id for a product surface, creating a minimal pool if
 * none exists yet (e.g. a free user who never had a subscription). Used at
 * agent-launch time so every new agent is linked to its pool.
 */
export async function getOrCreatePoolId(userId: string, productSurface = "hermesos"): Promise<string | null> {
  try {
    if (!supabaseAdmin) return null;
    const { data: existing } = await supabaseAdmin
      .from("pools")
      .select("id")
      .eq("user_id", userId)
      .eq("product_surface", productSurface)
      .maybeSingle();
    if (existing?.id) return existing.id as string;
    const { data: created } = await supabaseAdmin
      .from("pools")
      .insert({ user_id: userId, product_surface: productSurface })
      .select("id")
      .single();
    return (created?.id as string) ?? null;
  } catch (err) {
    // eslint-disable-next-line no-console -- Best-effort error log for pool bookkeeping; see above.
    console.error("[pools] getOrCreatePoolId failed", { userId, productSurface, err: String(err) });
    return null;
  }
}
