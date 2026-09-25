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
