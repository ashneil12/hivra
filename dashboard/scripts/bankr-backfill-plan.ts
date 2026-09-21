type InstanceBackfillInput = {
  status: string;
};

type WalletBackfillInput = {
  status: string;
  metadata?: Record<string, unknown> | null;
};

export type InstanceBankrBackfillAction = "provision" | "retry_provision" | "seed_skills" | "skip";

export function planInstanceBankrBackfill(params: {
  instance: InstanceBackfillInput;
  wallet: WalletBackfillInput | null;
}): InstanceBankrBackfillAction {
  if (!params.wallet) {
    return "provision";
  }

  if (params.wallet.status !== "active") {
    return "retry_provision";
  }

  if (params.instance.status === "running" && params.wallet.metadata?.bankrSuiteSeeded !== true) {
    return "seed_skills";
  }

  return "skip";
}
