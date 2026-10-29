/** @jest-environment jsdom */
/**
 * In a local-auth build @clerk/nextjs is the self-host client shim
 * (next.config.ts). Saving an agent wallet's withdrawal destination goes
 * through Clerk's useReverification, so the shim must provide it: a local
 * operator has no Clerk "confirm it's you" dialog, and the server shim answers
 * that check for a signed-in operator (clerk-shims.test.ts).
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { WithdrawalDestinationModal } from "@/components/wallet/AgentWalletCards";
import { SignIn } from "@/lib/self-host/clerk-client-shim";
import type { AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";

jest.mock("@clerk/nextjs", () => jest.requireActual("@/lib/self-host/clerk-client-shim"));
jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));
jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({ copy: { dashboard: { wallet: {} } }, locale: "en" }),
}));
jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn() },
}));

const DESTINATION = "0x2222222222222222222222222222222222222222";

function card(): AgentWalletCardData {
  return {
    instance: { id: "inst_1", name: "Scout", status: "running", provider: "proxmox", lane: "hermes" },
    wallet: {
      evmAddress: "0x000000000000000000000000000000000000ba5e",
      bankrWalletId: "bw_1",
      status: "active",
      withdrawalDestinationEvm: "0x1111111111111111111111111111111111111111",
      apiKeyStatus: "active",
    },
    balance: null,
    balances: [],
    withdrawalRecipients: [],
    balanceFailed: false,
    balanceError: null,
  };
}

it("opens the destination form and saves it for a local operator", async () => {
  const saved = { ...card().wallet!, withdrawalDestinationEvm: DESTINATION };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { wallet: saved } }),
  } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  const onSaved = jest.fn();
  const onClose = jest.fn();

  render(<WithdrawalDestinationModal card={card()} onClose={onClose} onSaved={onSaved} />);
  fireEvent.change(screen.getByPlaceholderText("0x..."), { target: { value: DESTINATION } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/instances/inst_1/bankr-wallet/withdraw-destination",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ destination: DESTINATION }) }),
  );
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(onClose).toHaveBeenCalled();
});

describe("local operator sign-in redirect", () => {
  const originalLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it.each([
    ["a backslash after the leading slash", "/\\attacker.example"],
    ["a literal tab", "/\t/attacker.example"],
  ])("sends the operator to the dashboard, not %s, after a successful sign in", async (_label, target) => {
    const assign = jest.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response) as unknown as typeof fetch;

    render(<SignIn forceRedirectUrl={target} fallbackRedirectUrl="/dashboard" />);
    fireEvent.change(document.getElementById("hivra-local-email") as HTMLInputElement, {
      target: { value: "operator@example.test" },
    });
    fireEvent.change(document.getElementById("hivra-local-password") as HTMLInputElement, {
      target: { value: "not-a-real-password" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open command center" }));
    });

    expect(assign).toHaveBeenCalledWith("/dashboard");
  });

  it("follows a safe deep link after a successful sign in", async () => {
    const assign = jest.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response) as unknown as typeof fetch;

    render(<SignIn forceRedirectUrl="/dashboard/computers?launch=1" fallbackRedirectUrl="/dashboard" />);
    fireEvent.change(document.getElementById("hivra-local-email") as HTMLInputElement, {
      target: { value: "operator@example.test" },
    });
    fireEvent.change(document.getElementById("hivra-local-password") as HTMLInputElement, {
      target: { value: "not-a-real-password" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open command center" }));
    });

    expect(assign).toHaveBeenCalledWith("/dashboard/computers?launch=1");
  });
});
