export interface AgentInstanceSummary {
  id: string;
  name: string;
  status: string;
  provider: string;
  /**
   * Which backend owns this agent's wallet routes. "hermes" = the classic
   * instance lane (/api/instances/[id]/bankr-wallet, full deposit + withdraw);
   * "hivra" = a Hivra-catalog CLI box (/api/hivra/agents/[id]/bankr-wallet),
   * which now also supports payouts: withdraw at .../withdraw and the saved
   * destination at .../set-destination.
   */
  lane: "hermes" | "hivra";
}

/** Lane-aware base path for an agent's bankr-wallet API routes. */
export function agentWalletApiBase(instance: Pick<AgentInstanceSummary, "id" | "lane">): string {
  return instance.lane === "hivra"
    ? `/api/hivra/agents/${instance.id}/bankr-wallet`
    : `/api/instances/${instance.id}/bankr-wallet`;
}

export interface InstanceBankrWalletPublicSummary {
  evmAddress: string | null;
  bankrWalletId: string | null;
  status: "active" | "pending" | "failed" | "revoked";
  withdrawalDestinationEvm: string | null;
  /**
   * When a newly saved destination can first receive a withdrawal; null or
   * absent once it can. The server enforces this; the card only explains it.
   */
  withdrawalDestinationAvailableAt?: string | null;
  apiKeyStatus: "active" | "missing" | "revoked" | "rotating" | "failed";
  /**
   * "user_connected": the user's own Bankr account, connected with a key they
   * created. "hivra_provisioned": a wallet Hivra created (existing agents
   * only). Absent means hivra_provisioned.
   */
  custody?: "hivra_provisioned" | "user_connected";
  apiKeyPreview?: string | null;
  connectedAt?: string | null;
}

export interface AgentWalletBalance {
  tokenSymbol: string;
  balanceDisplay: string;
  chain?: "Base";
  tokenAddress?: string | null;
  tokenDecimals?: number;
}

export interface AgentWalletBalanceError {
  failureType: string;
  retryable: boolean;
  requestId?: string | null;
  message: string;
}

export interface AgentWalletRecipient {
  id: string;
  address: string;
  normalizedAddress: string;
  label: string | null;
  isPrimary: boolean;
  useCount: number;
  lastUsedAt: string;
}

export interface AgentWalletCardData {
  instance: AgentInstanceSummary;
  wallet: InstanceBankrWalletPublicSummary | null;
  balance: AgentWalletBalance | null;
  balances: AgentWalletBalance[];
  withdrawalRecipients: AgentWalletRecipient[];
  balanceFailed: boolean;
  balanceError: AgentWalletBalanceError | null;
}

export interface AgentWalletsState {
  totalAgents: number;
  cards: AgentWalletCardData[];
}

type WalletApiData = {
  wallet?: InstanceBankrWalletPublicSummary | null;
  balance?: AgentWalletBalance | null;
  balances?: AgentWalletBalance[] | null;
  withdrawalRecipients?: AgentWalletRecipient[] | null;
  balanceError?: AgentWalletBalanceError | null;
};

function cardFromWalletData(instance: AgentInstanceSummary, data: WalletApiData | undefined): AgentWalletCardData {
  const balances = Array.isArray(data?.balances) ? data.balances : [];
  const wallet = data?.wallet ?? null;

  return {
    instance,
    wallet,
    balance: balances.find((balance) => balance.tokenSymbol === "ETH") ?? data?.balance ?? null,
    balances,
    withdrawalRecipients: Array.isArray(data?.withdrawalRecipients) ? data.withdrawalRecipients : [],
    balanceFailed: Boolean(wallet?.status === "active" && balances.length === 0 && !data?.balance),
    balanceError: data?.balanceError ?? null,
  };
}

function failedWalletCard(instance: AgentInstanceSummary): AgentWalletCardData {
  return { instance, wallet: null, balance: null, balances: [], withdrawalRecipients: [], balanceFailed: true, balanceError: null };
}

async function requestWalletData(
  instance: AgentInstanceSummary,
  method: "GET"
): Promise<{ ok: true; data: WalletApiData | undefined } | { ok: false }> {
  const response = await fetch(agentWalletApiBase(instance), { method });
  if (!response.ok) return { ok: false };

  const body = await response.json().catch(() => ({}));
  return { ok: true, data: body?.data as WalletApiData | undefined };
}

async function loadWalletCard(instance: AgentInstanceSummary): Promise<AgentWalletCardData> {
  try {
    const initial = await requestWalletData(instance, "GET");
    if (!initial.ok) return failedWalletCard(instance);

    return cardFromWalletData(instance, initial.data);
  } catch {
    return failedWalletCard(instance);
  }
}

// Hivra-catalog CLI agents that get a per-box Bankr wallet. Mirrors
// bankrSkillsDirForType in @/lib/hivra/bankr-skills-seed (server-side gate);
// kept as a literal here so this stays a client-safe module.
const HIVRA_WALLET_AGENT_TYPES = new Set(["codex", "claude-code"]);

type HivraAgentListRow = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  type?: unknown;
};

async function loadHivraWalletInstances(): Promise<AgentInstanceSummary[]> {
  try {
    const response = await fetch("/api/hivra/agents", { method: "GET" });
    // 404 = hivra lane disabled on this host; the wallet page is hermes-only there.
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    const agents = Array.isArray(body?.data?.agents) ? (body.data.agents as HivraAgentListRow[]) : [];
    return agents
      .filter(
        (agent) =>
          typeof agent.id === "string" &&
          agent.status === "running" &&
          typeof agent.type === "string" &&
          HIVRA_WALLET_AGENT_TYPES.has(agent.type)
      )
      .map((agent) => ({
        id: agent.id as string,
        name: typeof agent.name === "string" && agent.name ? agent.name : (agent.type as string),
        status: "running",
        provider: agent.type as string,
        lane: "hivra" as const,
      }));
  } catch {
    return [];
  }
}

export async function loadAgentWalletsFromApi(): Promise<AgentWalletsState> {
  const [instancesResult, hivraInstances] = await Promise.all([
    fetch("/api/instances?summary=true", { method: "GET" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json().catch(() => ({}));
        return Array.isArray(body?.data) ? (body.data as Omit<AgentInstanceSummary, "lane">[]) : [];
      })
      .catch(() => null),
    loadHivraWalletInstances(),
  ]);

  if (instancesResult === null && hivraInstances.length === 0) {
    return { totalAgents: 0, cards: [] };
  }

  const instances: AgentInstanceSummary[] = (instancesResult ?? []).map((instance) => ({
    ...instance,
    lane: "hermes" as const,
  }));
  const runningInstances = [
    ...instances.filter((instance) => instance.status === "running"),
    ...hivraInstances,
  ];
  const cards = await Promise.all(runningInstances.map(loadWalletCard));

  return {
    totalAgents: instances.length + hivraInstances.length,
    cards,
  };
}
