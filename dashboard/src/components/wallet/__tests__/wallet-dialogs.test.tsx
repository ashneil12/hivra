/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import {
  AgentWalletCard,
  AgentWalletWithdrawModal,
  BankrTrustFooter,
  WithdrawalDestinationModal,
} from "../AgentWalletCards";
import { QuoteCard } from "../QuoteSection";
import {
  ConfirmDialog,
  UnlockPromptCard,
  WithdrawAddressForm,
  WithdrawDestinationCard,
  WithdrawSection,
} from "../WithdrawSection";
import type { AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";
import type { DepositQuotePayload } from "@/lib/wallet/format";

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));

jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({ copy: { dashboard: { wallet: {} } }, locale: "en" }),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn() },
}));

// Clerk's useReverification, faithfully enough: a reverification answer from
// the server opens "confirm it's you"; confirming retries the request,
// closing the dialog rejects with a cancellation error.
const mockReverification = { cancel: false, prompts: 0 };
jest.mock("@clerk/nextjs", () => ({
  useReverification:
    (fetcher: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      const first = (await fetcher(...args)) as { clerk_error?: { reason?: string } } | undefined;
      if (first?.clerk_error?.reason !== "reverification-error") return first;
      mockReverification.prompts += 1;
      if (mockReverification.cancel) throw Object.assign(new Error("cancelled"), { code: "reverification_cancelled" });
      return fetcher(...args);
    },
}));
jest.mock("@clerk/nextjs/errors", () => ({
  isReverificationCancelledError: (err: { code?: string }) => err?.code === "reverification_cancelled",
}));

const WALLET = "0x000000000000000000000000000000000000ba5e";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HERMESOS_CONTRACT = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";

function card(overrides: Partial<AgentWalletCardData> = {}): AgentWalletCardData {
  return {
    instance: { id: "inst_1", name: "Scout", status: "running", provider: "proxmox", lane: "hermes" },
    wallet: {
      evmAddress: WALLET,
      bankrWalletId: "bw_1",
      status: "active",
      withdrawalDestinationEvm: RECIPIENT,
      apiKeyStatus: "active",
    },
    balance: null,
    balances: [
      { tokenSymbol: "ETH", balanceDisplay: "0.010000", chain: "Base", tokenAddress: null, tokenDecimals: 18 },
    ],
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

afterEach(() => {
  jest.useRealTimers();
  mockReverification.cancel = false;
  mockReverification.prompts = 0;
});

const REVERIFY = { clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: "strict" } } };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("agent wallet modals", () => {
  it("renders the withdraw form in a body portal with the actions pinned in the footer", () => {
    const onClose = jest.fn();
    const { container } = render(
      <AgentWalletWithdrawModal card={card()} onClose={onClose} onSubmitted={jest.fn()} />
    );
    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });
    // Out of <main> (the render container) and into <body>, above the shell.
    expect(container).not.toContainElement(dialog);
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // The pinned footer is the panel's last block and holds both actions.
    const footer = dialog.lastElementChild as HTMLElement;
    expect(within(footer).getByRole("button", { name: /yes, withdraw/i })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("never throws away the prefilled withdraw form on a backdrop tap", () => {
    const onClose = jest.fn();
    render(<AgentWalletWithdrawModal card={card()} onClose={onClose} onSubmitted={jest.fn()} />);
    expect(screen.getByLabelText(/amount to withdraw/i)).toHaveValue("0.010000");

    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();

    // Cancel, Close and Escape still work.
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("locks every exit while a withdrawal is in flight", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    global.fetch = jest.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; })
    ) as unknown as typeof fetch;
    const onClose = jest.fn();
    render(<AgentWalletWithdrawModal card={card()} onClose={onClose} onSubmitted={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, withdraw/i }));
    });
    expect(screen.getByRole("button", { name: /withdrawing/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch({ ok: false, status: 500, json: async () => ({ error: "Bankr unavailable" }) } as Response);
    });
    // The error sits in the pinned footer, next to the action it is about.
    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });
    expect(within(dialog.lastElementChild as HTMLElement).getByRole("alert")).toHaveTextContent("Bankr unavailable");
  });

  it("keeps a typed primary recipient from a backdrop tap, but lets an untouched one close", () => {
    const onClose = jest.fn();
    render(<WithdrawalDestinationModal card={card()} onClose={onClose} onSaved={jest.fn()} />);
    const backdrop = screen.getByRole("presentation");

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("0x..."), { target: { value: "0x2222" } });
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    const footer = screen.getByRole("dialog").lastElementChild as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("asks the user to confirm it's them, then saves the new destination", async () => {
    const saved = { ...card().wallet!, withdrawalDestinationEvm: "0x2222222222222222222222222222222222222222" };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, REVERIFY))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { wallet: saved } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = jest.fn();
    const onClose = jest.fn();
    render(<WithdrawalDestinationModal card={card()} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText("0x..."), { target: { value: saved.withdrawalDestinationEvm } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(mockReverification.prompts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/instances/inst_1/bankr-wallet/withdraw-destination",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ destination: saved.withdrawalDestinationEvm }) })
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the form open and says nothing changed when the user closes the confirm-it's-you dialog", async () => {
    mockReverification.cancel = true;
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(403, REVERIFY)) as unknown as typeof fetch;
    const onSaved = jest.fn();
    const onClose = jest.fn();
    render(<WithdrawalDestinationModal card={card()} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText("0x..."), { target: { value: "0x2222222222222222222222222222222222222222" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/confirm it's you to save this address\. nothing was changed/i);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends a withdrawal only to the saved destination, with no other recipient to pick", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { txHash: "0xsent", asset: "ETH", amountDisplay: "0.01", recipientAddress: RECIPIENT } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentWalletWithdrawModal card={card()} onClose={jest.fn()} onSubmitted={jest.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });
    expect(within(dialog).getByText(RECIPIENT)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/recipient address/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/set as primary/i)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /yes, withdraw/i }));
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.recipientAddress).toBe(RECIPIENT);
    expect(body).not.toHaveProperty("setPrimaryRecipient");
  });

  it("holds a withdrawal to a destination still in its cooldown, and explains when it opens", () => {
    const availableAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(
      <AgentWalletWithdrawModal
        card={card({ wallet: { ...card().wallet!, withdrawalDestinationAvailableAt: availableAt } })}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });
    expect(dialog).toHaveTextContent(/saved recently\. for your safety, withdrawals to it open/i);
    expect(within(dialog).getByRole("button", { name: /yes, withdraw/i })).toBeDisabled();
  });

  it("cannot withdraw before a destination is saved", () => {
    render(
      <AgentWalletWithdrawModal
        card={card({ wallet: { ...card().wallet!, withdrawalDestinationEvm: null } })}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Withdraw on Base." });
    expect(dialog).toHaveTextContent(/no withdrawal destination saved/i);
    expect(within(dialog).getByRole("button", { name: /yes, withdraw/i })).toBeDisabled();
  });

  it("never calls a sweep-only deposit address non-custodial", () => {
    const { container, rerender } = render(<BankrTrustFooter />);
    expect(container).not.toHaveTextContent(/non-custodial/i);
    expect(container).toHaveTextContent(/payment address on Base/i);
    rerender(<BankrTrustFooter withdrawable />);
    expect(container).toHaveTextContent(/your wallet · withdraw any time/i);
  });
});

describe("AgentWalletCard", () => {
  it("shows why Withdraw is disabled as visible text", () => {
    render(<AgentWalletCard card={card({ balances: [] })} {...cardProps()} />);
    const withdraw = screen.getByRole("button", { name: /withdraw on base/i });
    expect(withdraw).toBeDisabled();
    const reason = screen.getByText("No Base token balance to withdraw");
    expect(withdraw).toHaveAttribute("aria-describedby", reason.id);
  });

  it("has no disabled reason when there is something to withdraw", () => {
    render(<AgentWalletCard card={card()} {...cardProps()} />);
    expect(screen.getByRole("button", { name: /withdraw on base/i })).toBeEnabled();
    expect(screen.queryByText("No Base token balance to withdraw")).not.toBeInTheDocument();
  });

  it("fits an 18-decimal balance to 6 digits and keeps the exact value on title and copy", () => {
    const exactRaw = "1843201.123456789012345678";
    render(
      <AgentWalletCard
        card={card({
          balances: [
            { tokenSymbol: "HERMESOS", balanceDisplay: exactRaw, chain: "Base", tokenAddress: HERMESOS_CONTRACT, tokenDecimals: 18 },
            { tokenSymbol: "BNKR", balanceDisplay: "52718.293847561029384756", chain: "Base", tokenAddress: HERMESOS_CONTRACT, tokenDecimals: 18 },
          ],
        })}
        {...cardProps()}
      />
    );
    const headline = screen.getByTestId("agent-wallet-headline-HERMESOS");
    expect(headline).toHaveTextContent("1,843,201.123456");
    expect(headline).not.toHaveTextContent("1,843,201.123457");
    expect(headline).toHaveAttribute("title", "1,843,201.123456789012345678");
    expect(headline.style.overflowWrap).toBe("anywhere");
    expect(screen.getByRole("button", { name: "Copy exact Base HERMESOS balance" })).toBeInTheDocument();

    const tiles = screen.getByLabelText("Base token balances");
    expect(within(tiles).getByText("52,718.293847")).toHaveAttribute("title", "52,718.293847561029384756");
  });

  it("offers no Copy exact button when nothing was cut", () => {
    render(<AgentWalletCard card={card()} {...cardProps()} />);
    expect(screen.getByTestId("agent-wallet-headline-ETH")).toHaveTextContent("0.010000");
    expect(screen.queryByRole("button", { name: /copy exact/i })).not.toBeInTheDocument();
  });
});

describe("legacy withdraw lane", () => {
  it("shows the saved withdraw destination in full with a copy button", () => {
    render(<WithdrawDestinationCard address={RECIPIENT} loading={false} onEdit={jest.fn()} />);
    expect(screen.getByText(RECIPIENT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy withdraw destination" })).toBeInTheDocument();
    expect(screen.queryByText(/…/)).not.toBeInTheDocument();
  });

  it("renders ConfirmDialog in a body portal with Cancel and Confirm pinned in the footer", () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    const { container } = render(
      <ConfirmDialog
        title="Withdraw all $HERMESOS"
        body={<p>Body</p>}
        confirmLabel="Yes, withdraw everything"
        confirmTone="destructive"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Withdraw all $HERMESOS" });
    expect(container).not.toContainElement(dialog);
    const footer = dialog.lastElementChild as HTMLElement;
    fireEvent.click(within(footer).getByRole("button", { name: "Yes, withdraw everything" }));
    fireEvent.click(within(footer).getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Escape and the 44px Close cancel too.
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("tells the owner when a newly saved withdraw address opens, and holds Withdraw all until then", () => {
    const availableAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    render(<WithdrawDestinationCard address={RECIPIENT} availableAt={availableAt} loading={false} onEdit={jest.fn()} />);
    expect(screen.getByText(/new address\. for your safety, withdrawals to it open/i)).toBeInTheDocument();

    render(
      <WithdrawSection
        tokenSymbol="HERMESOS"
        balanceDisplay="5000000"
        withdrawAddress={RECIPIENT}
        withdrawAvailableAt={availableAt}
        onWithdrew={jest.fn()}
        onRequestSetAddress={jest.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /withdraw all/i })).toBeDisabled();
    expect(screen.getByText(/your withdraw address was saved recently/i)).toBeInTheDocument();
  });

  it("saves a withdraw address after the confirm-it's-you check and reports when it opens", async () => {
    const availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, REVERIFY))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { status: "saved", address: RECIPIENT, availableAt } })) as unknown as typeof fetch;
    const onSaved = jest.fn();
    render(<WithdrawAddressForm initialAddress={null} onCancel={jest.fn()} onSaved={onSaved} />);
    const dialog = screen.getByRole("dialog", { name: "Set withdraw address" });

    fireEvent.change(within(dialog).getByPlaceholderText("0x..."), { target: { value: RECIPIENT } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(within(dialog.lastElementChild as HTMLElement).getByRole("button", { name: "Save withdraw address" }));
    });

    expect(mockReverification.prompts).toBe(1);
    expect(onSaved).toHaveBeenCalledWith(RECIPIENT, availableAt);
  });

  it("keeps a typed withdraw address from a backdrop tap", () => {
    const onCancel = jest.fn();
    render(<WithdrawAddressForm initialAddress={null} onCancel={onCancel} onSaved={jest.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Set withdraw address" });
    const footer = dialog.lastElementChild as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Save withdraw address" })).toBeDisabled();
    expect(within(footer).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText("0x..."), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByRole("presentation"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("gives the unlock prompt a 44px dismiss named Close", () => {
    const onDismiss = jest.fn();
    render(<UnlockPromptCard mode="holding" unlocking={false} onUnlock={jest.fn()} onDismiss={onDismiss} />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.style.width).toBe("44px");
    expect(close.style.height).toBe("44px");
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("QuoteCard wallet link", () => {
  function depositQuote(overrides: Partial<DepositQuotePayload> = {}): DepositQuotePayload {
    return {
      id: "dq_1",
      tier: "pro",
      thresholdTierCode: "PRO_STANDARD",
      epoch: "standard",
      usdTargetCents: 14900,
      priceUsdAtQuote: "0.0000025",
      tokensRequiredRaw: "59600000000000000000000000",
      tokensRequiredDisplay: "59600000",
      tokenSymbol: "Hivra",
      tokenDecimals: 18,
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: "active",
      source: "test",
      ...overrides,
    };
  }

  function renderQuote(quote: DepositQuotePayload, depositAddress: string | null = WALLET) {
    return render(
      <QuoteCard
        tier="pro"
        quote={quote}
        alreadyEligible={false}
        launchEpoch={false}
        minting={false}
        depositAddress={depositAddress}
        onMint={jest.fn()}
      />
    );
  }

  it("offers Open in wallet with the exact raw amount for a live quote", () => {
    renderQuote(depositQuote());
    expect(screen.getByRole("link", { name: /open in wallet/i })).toHaveAttribute(
      "href",
      `ethereum:${HERMESOS_CONTRACT}@8453/transfer?address=${WALLET}&uint256=59600000000000000000000000`
    );
  });

  it("offers no wallet link unless token, exact amount and address are all known", () => {
    const { unmount } = renderQuote(depositQuote(), null);
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    unmount();

    // Raw that doesn't match the amount shown.
    const second = renderQuote(depositQuote({ tokensRequiredRaw: "59600000000000000000000001" }));
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    second.unmount();

    // Another token.
    const third = renderQuote(depositQuote({ tokenSymbol: "USDC", tokenDecimals: 6 }));
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    third.unmount();

    // Expired.
    renderQuote(depositQuote({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
  });
});
