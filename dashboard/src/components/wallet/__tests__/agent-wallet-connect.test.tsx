/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  AgentWalletCard,
  AgentWalletManagementModal,
  AgentWalletsSection,
  ConnectBankrModal,
  DisconnectBankrModal,
} from "../AgentWalletCards";
import type { AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";

// Public Base token contracts, named so the secret scan reads them as addresses.
const USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));

jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({
    copy: {
      dashboard: {
        wallet: {
          agentWallets: {
            ariaLabel: "Agent wallets",
            title: "Agent wallets.",
            subtitle: "One wallet per agent",
            emptyNoAgents: "No agents yet.",
            deployAgent: "Deploy an agent",
            runningEmpty: "Running agents will appear here.",
          },
        },
      },
    },
    locale: "en",
  }),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn() },
}));

const USER_WALLET = "0x00000000000000000000000000000000000c0ffe";
const HIVRA_WALLET = "0x000000000000000000000000000000000000ba5e";

function card(overrides: Partial<AgentWalletCardData> = {}): AgentWalletCardData {
  return {
    instance: { id: "agent_1", name: "Scout", status: "running", provider: "codex", lane: "hivra" },
    wallet: null,
    balance: null,
    balances: [],
    withdrawalRecipients: [],
    balanceFailed: false,
    balanceError: null,
    ...overrides,
  };
}

function cardProps() {
  return {
    onDeposit: jest.fn(),
    onManage: jest.fn(),
    onSetDestination: jest.fn(),
    onWithdraw: jest.fn(),
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onRefresh: jest.fn(),
  };
}

const connectedWallet = {
  evmAddress: USER_WALLET,
  bankrWalletId: `user:${USER_WALLET}`,
  status: "active" as const,
  withdrawalDestinationEvm: null,
  apiKeyStatus: "active" as const,
  custody: "user_connected" as const,
  apiKeyPreview: "bk_usr_ab...wxyz",
  connectedAt: "2026-09-23T12:00:00.000Z",
};

const hivraWallet = {
  evmAddress: HIVRA_WALLET,
  bankrWalletId: "wlt_1",
  status: "active" as const,
  withdrawalDestinationEvm: null,
  apiKeyStatus: "active" as const,
  custody: "hivra_provisioned" as const,
  apiKeyPreview: null,
  connectedAt: null,
};

describe("agent wallet card custody", () => {
  it("offers only Connect Bankr account (never Create wallet) to an agent without a wallet", () => {
    const props = cardProps();
    render(<AgentWalletCard card={card()} {...props} />);

    expect(screen.queryByRole("button", { name: /create wallet/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Bankr account" }));
    expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ wallet: null }), "connect");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("offers the same connect flow to a pending row that never got a Bankr wallet", () => {
    const props = cardProps();
    render(
      <AgentWalletCard
        card={card({ wallet: { ...hivraWallet, evmAddress: null, bankrWalletId: null, status: "pending", apiKeyStatus: "missing" } })}
        {...props}
      />
    );
    expect(screen.getByRole("button", { name: "Connect Bankr account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /withdraw on base/i })).not.toBeInTheDocument();
  });

  it("shows a connected wallet as the user's own, with disconnect and no Hivra withdrawal", () => {
    const props = cardProps();
    render(<AgentWalletCard card={card({ wallet: connectedWallet })} {...props} />);

    expect(screen.getByTestId("agent-wallet-custody")).toHaveTextContent("Your Bankr account");
    expect(screen.queryByRole("button", { name: /withdraw on base/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/primary withdrawal recipient/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage at bankr.bot" })).toHaveAttribute("href", "https://bankr.bot");
    expect(screen.getByText(/Key bk_usr_ab\.\.\.wxyz/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(props.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing Hivra-created wallet working and offers an optional switch", () => {
    const props = cardProps();
    render(
      <AgentWalletCard
        card={card({
          wallet: hivraWallet,
          balances: [{ tokenSymbol: "USDC", balanceDisplay: "3", chain: "Base", tokenAddress: USDC_CONTRACT, tokenDecimals: 6 }],
        })}
        {...props}
      />
    );

    expect(screen.getByTestId("agent-wallet-custody")).toHaveTextContent("Created by Hivra");
    expect(screen.getByRole("button", { name: /withdraw on base/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Switch to your Bankr account" }));
    expect(props.onConnect).toHaveBeenCalledWith(expect.anything(), "replace");
  });
});

describe("management disclosure", () => {
  it("says Hivra can move funds from a wallet it created", () => {
    render(<AgentWalletManagementModal card={card({ wallet: hivraWallet })} onClose={jest.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/Hivra can use that key, or its Bankr partner key, to move funds/i);
  });

  it("says Hivra's partner account has no access to a connected wallet", () => {
    render(<AgentWalletManagementModal card={card({ wallet: connectedWallet })} onClose={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/partner account has no access to your account/i);
    expect(dialog).toHaveTextContent(/keeps working at Bankr, including any copy the agent already loaded, until you revoke it/i);
  });
});

describe("ConnectBankrModal", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("needs a key and explicit consent before it sends anything", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: connectedWallet } }),
    });
    const onConnected = jest.fn();
    const onClose = jest.fn();
    render(<ConnectBankrModal card={card()} mode="connect" onClose={onClose} onConnected={onConnected} />);

    const dialog = screen.getByRole("dialog");
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: " bk_usr_abcd1234_secretvalue " } });
    expect(connect).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra to store this key/i }));
    expect(connect).toBeEnabled();

    await act(async () => {
      fireEvent.click(connect);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents/agent_1/bankr-wallet/connect", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      apiKey: "bk_usr_abcd1234_secretvalue",
      consent: true,
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(connectedWallet));
    expect(onClose).toHaveBeenCalled();
  });

  it("requires the switch confirmation and sends replaceProvisionedWallet in replace mode", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: "Withdraw everything from the current wallet first (3 USDC).", code: "balance_not_empty" }),
    });
    render(<ConnectBankrModal card={card({ wallet: hivraWallet })} mode="replace" onClose={jest.fn()} onConnected={jest.fn()} />);

    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));
    const submit = within(dialog).getByRole("button", { name: "Switch wallet" });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Replace the wallet Hivra created/i }));

    await act(async () => {
      fireEvent.click(submit);
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ replaceProvisionedWallet: true, consent: true });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Withdraw everything from the current wallet first");
  });
});

describe("runtime delivery is reported, not assumed", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("tells the user when a Hermes agent only gets the key at its next update", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: connectedWallet, configSync: "skipped" } }),
    });
    const onClose = jest.fn();
    const onConnected = jest.fn();
    const hermesCard = card({ instance: { id: "inst_1", name: "Scout", status: "running", provider: "openai", lane: "hermes" } });
    render(<ConnectBankrModal card={hermesCard} mode="connect" onClose={onClose} onConnected={onConnected} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });

    expect(onConnected).toHaveBeenCalledWith(connectedWallet);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("The agent gets the key at its next update.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tells the user a stopped Hivra box hasn't received the key", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: connectedWallet, envSync: "skipped" } }),
    });
    render(<ConnectBankrModal card={card()} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });

    expect(await within(dialog).findByRole("status")).toHaveTextContent(/isn't running, so it gets the key when it next starts/);
  });

  it("never presents a plain restart as applying a webfree wallet change", async () => {
    // Restart and Stop/Start reload the same persisted env; only Update rewrites it.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: connectedWallet, configSync: "skipped", configSyncReason: "restart_not_requested" } }),
    });
    const hermesCard = card({ instance: { id: "inst_1", name: "Scout", status: "running", provider: "openai", lane: "hermes" } });
    render(<ConnectBankrModal card={hermesCard} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent(/run Update/);
    expect(status).not.toHaveTextContent(/restart it/i);
  });

  it("tells the user a box that can't be verified never gets the key, instead of asking them to retry", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: connectedWallet, envSync: "failed", envSyncReason: "identity_unverifiable" } }),
    });
    render(<ConnectBankrModal card={card()} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent(/can't be verified/);
    expect(status).not.toHaveTextContent(/Connect again/);
  });

  it("says so when the old wallet's keys couldn't be revoked after a switch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { wallet: connectedWallet, replacedProvisionedWallet: true, oldKeysRevoked: false, envSync: "synced" },
      }),
    });
    const onClose = jest.fn();
    render(<ConnectBankrModal card={card({ wallet: hivraWallet })} mode="replace" onClose={onClose} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Replace the wallet Hivra created/i }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Switch wallet" }));
    });

    expect(await within(dialog).findByRole("status")).toHaveTextContent(/couldn't confirm the old wallet's keys were revoked/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks for the switch confirmation when the server says the agent has a Hivra wallet", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, code: "replace_not_confirmed", error: "This agent already has a wallet Hivra created." }),
    });
    render(<ConnectBankrModal card={card()} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });

    expect(await within(dialog).findByRole("checkbox", { name: /Replace the wallet Hivra created/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Switch wallet" })).toBeDisabled();
  });

  it("tells the user to revoke at Bankr when the key couldn't be removed from the agent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { wallet: { ...connectedWallet, status: "revoked", evmAddress: null }, configSync: "skipped" },
      }),
    });
    const onClose = jest.fn();
    render(<DisconnectBankrModal card={card({ wallet: connectedWallet })} onClose={onClose} onDisconnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents/agent_1/bankr-wallet/connect", { method: "DELETE" });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(/Revoke it at bankr\.bot\/api-keys/);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Hermes agents restart to apply a wallet change only when the user asks", () => {
  const fetchMock = jest.fn();
  const RESTART_LABEL = /Restart the agent now if it needs a restart to pick this up/i;
  const hermesCard = (overrides: Partial<AgentWalletCardData> = {}) =>
    card({ instance: { id: "inst_1", name: "Scout", status: "running", provider: "openai", lane: "hermes" }, ...overrides });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  async function connectWith(data: Record<string, unknown>, options: { tickRestart?: boolean } = {}) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { wallet: connectedWallet, ...data } }) });
    const onClose = jest.fn();
    render(<ConnectBankrModal card={hermesCard()} mode="connect" onClose={onClose} onConnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bankr API key"), { target: { value: "bk_usr_abcd1234_secretvalue" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I authorise Hivra/i }));
    if (options.tickRestart) fireEvent.click(within(dialog).getByRole("checkbox", { name: RESTART_LABEL }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    });
    return { dialog, onClose, sent: JSON.parse(fetchMock.mock.calls[0][1].body) };
  }

  async function disconnectWith(data: Record<string, unknown>, options: { untickRestart?: boolean } = {}) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { wallet: { ...connectedWallet, status: "revoked", evmAddress: null }, ...data } }),
    });
    const onClose = jest.fn();
    render(<DisconnectBankrModal card={hermesCard({ wallet: connectedWallet })} onClose={onClose} onDisconnected={jest.fn()} />);
    const dialog = screen.getByRole("dialog");
    if (options.untickRestart) fireEvent.click(within(dialog).getByRole("checkbox", { name: RESTART_LABEL }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    });
    return { dialog, onClose, init: fetchMock.mock.calls[0][1] };
  }

  it("offers the restart unticked on connect and ticked on disconnect", () => {
    const { unmount } = render(
      <ConnectBankrModal card={hermesCard()} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />
    );
    const connectRestart = within(screen.getByRole("dialog")).getByRole("checkbox", { name: RESTART_LABEL });
    expect(connectRestart).not.toBeChecked();
    expect(screen.getByRole("dialog")).toHaveTextContent("about 1–3 minutes; chats in progress stop");
    unmount();

    render(<DisconnectBankrModal card={hermesCard({ wallet: connectedWallet })} onClose={jest.fn()} onDisconnected={jest.fn()} />);
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: RESTART_LABEL })).toBeChecked();
  });

  it("does not offer the restart for a Hivra box", () => {
    const { unmount } = render(<ConnectBankrModal card={card()} mode="connect" onClose={jest.fn()} onConnected={jest.fn()} />);
    expect(screen.queryByRole("checkbox", { name: RESTART_LABEL })).not.toBeInTheDocument();
    unmount();

    render(<DisconnectBankrModal card={card({ wallet: connectedWallet })} onClose={jest.fn()} onDisconnected={jest.fn()} />);
    expect(screen.queryByRole("checkbox", { name: RESTART_LABEL })).not.toBeInTheDocument();
  });

  it("asks for no restart on connect unless the user ticks it", async () => {
    const { sent } = await connectWith({ configSync: "skipped", configSyncReason: "restart_not_requested" });
    expect(sent).toMatchObject({ consent: true, restartAgent: false });
  });

  it("asks for the restart on connect when the user ticks it, and says the agent is restarting", async () => {
    const { dialog, onClose, sent } = await connectWith({ configSync: "update_started" }, { tickRestart: true });
    expect(sent).toMatchObject({ restartAgent: true });
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Connected. The agent is restarting to apply this.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says when a connected key waits for the agent's next update", async () => {
    const { dialog } = await connectWith({ configSync: "skipped", configSyncReason: "restart_not_requested" });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Connected. The agent picks up the key at its next update, or run Update on its page to apply it now."
    );
  });

  it("asks for the restart on disconnect by default, and says the agent is restarting", async () => {
    const { dialog, onClose, init } = await disconnectWith({ configSync: "update_started" });
    expect(init).toMatchObject({ method: "DELETE", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ restartAgent: true });
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent("The agent is restarting to apply this.");
    expect(status).toHaveTextContent(/still works at Bankr until you revoke it at bankr\.bot\/api-keys/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends no restart when the user unticks it, and says the agent keeps the key until it restarts", async () => {
    const { dialog, init } = await disconnectWith(
      { configSync: "skipped", configSyncReason: "restart_not_requested" },
      { untickRestart: true }
    );
    expect(JSON.parse(init.body)).toEqual({ restartAgent: false });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Hivra deleted its copy. The agent keeps the key until its next update (run Update on its page to apply it now); revoke it at bankr.bot/api-keys to stop it immediately."
    );
  });

  it("asks the user to run Update when an update was already running during connect", async () => {
    const { dialog } = await connectWith({ configSync: "skipped", configSyncReason: "update_in_progress" }, { tickRestart: true });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Your agent is already updating. Run Update once it finishes to apply this change."
    );
  });

  it("asks the user to run Update and revoke at Bankr when an update was already running during disconnect", async () => {
    const { dialog } = await disconnectWith({ configSync: "skipped", configSyncReason: "update_in_progress" });
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent(/Run Update once it finishes to apply this change/);
    expect(status).toHaveTextContent(/revoke it at bankr\.bot\/api-keys/);
    expect(status).not.toHaveTextContent(/restarting/);
  });
});

describe("AgentWalletsSection", () => {
  it("opens the connect dialog from a card and no longer offers Hivra-created wallets", () => {
    render(
      <AgentWalletsSection
        state={{ totalAgents: 1, cards: [card()] }}
        onRefresh={jest.fn()}
        onWalletUpdated={jest.fn()}
      />
    );

    expect(screen.getByText(/connect your own Bankr account/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect Bankr account" }));
    expect(screen.getByRole("dialog", { name: /Connect your Bankr account to Scout/i })).toBeInTheDocument();
  });
});
