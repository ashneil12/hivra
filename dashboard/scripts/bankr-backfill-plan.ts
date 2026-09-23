type InstanceBackfillInput = {
  status: string;
};

type WalletBackfillInput = {
  status: string;
  metadata?: Record<string, unknown> | null;
};

export type InstanceBankrBackfillAction = "seed_skills" | "skip";

/**
 * The backfill never creates or retries an agent wallet. Hivra no longer
 * provisions wallets for agents (new ones connect the user's own Bankr
 * account), and a pending row may date from the old eager provisioning that
 * nobody asked for. All it still does is seed the static Bankr skills onto a
 * running agent that already has an active wallet.
 */
export function planInstanceBankrBackfill(params: {
  instance: InstanceBackfillInput;
  wallet: WalletBackfillInput | null;
}): InstanceBankrBackfillAction {
  if (!params.wallet || params.wallet.status !== "active") {
    return "skip";
  }

  if (params.instance.status === "running" && params.wallet.metadata?.bankrSuiteSeeded !== true) {
    return "seed_skills";
  }

  return "skip";
}
