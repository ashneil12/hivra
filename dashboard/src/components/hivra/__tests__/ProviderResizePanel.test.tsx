/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderResizePanel } from "../ProviderResizePanel";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  PROVIDER_RESIZE_DOWNTIME_NOTICE,
  type ProviderResizeCatalog,
  type ProviderResizeQuote,
} from "@/lib/hivra/provider-agent-resize-contract";

const mockGetState = jest.fn();
const mockReview = jest.fn();
const mockConfirm = jest.fn();

jest.mock("@/lib/hivra/agent-api", () => {
  class ProviderResizeApiError extends Error {
    constructor(readonly code: string | null, message: string) {
      super(message);
      this.name = "ProviderResizeApiError";
    }
  }
  return {
    ProviderResizeApiError,
    getProviderResizeState: (...args: unknown[]) => mockGetState(...args),
    reviewProviderResize: (...args: unknown[]) => mockReview(...args),
    confirmProviderResize: (...args: unknown[]) => mockConfirm(...args),
  };
});

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEXT_OPERATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-09-04T14:00:00.000Z";

const agent: HivraAgent = {
  id: AGENT_ID,
  name: "Provider computer",
  type: "codex",
  status: "stopped",
  cpu: 2,
  ram: 4,
  deployment_mode: "self-managed",
  computer_substrate: "provider-vm",
};

const source = {
  serverTypeId: 1, serverType: "cpx22", architecture: "x86" as const, cores: 2, memoryGb: 4,
  advertisedDiskGb: 80, cpuType: "shared" as const,
  price: { currency: "EUR", hourlyGross: "0.0095", monthlyGross: "5.95" },
};
const target = {
  serverTypeId: 2, serverType: "cpx32", architecture: "x86" as const, cores: 4, memoryGb: 8,
  advertisedDiskGb: 160, cpuType: "shared" as const,
  price: { currency: "EUR", hourlyGross: "0.0188", monthlyGross: "11.90" },
};

function quote(expiresAt = new Date(Date.now() + 60_000).toISOString()): ProviderResizeQuote {
  return {
    operationId: OPERATION_ID,
    quoteFingerprint: "d".repeat(64),
    agentId: AGENT_ID,
    providerServerId: "42",
    location: "fsn1",
    source,
    target,
    existingDiskGb: 80,
    upgradeDisk: false,
    observedAt: NOW,
    expiresAt,
    downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  };
}

const catalog: ProviderResizeCatalog = {
  capability: "hetzner-change-type-v1",
  agentId: AGENT_ID,
  providerServerId: "42",
  location: "fsn1",
  providerPowerState: "off",
  providerLocked: false,
  requiresPowerOff: true,
  upgradeDisk: false,
  existingDiskGb: 80,
  current: source,
  offers: [{ ...target, description: "CPX32" }],
  observedAt: NOW,
  downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
};

describe("ProviderResizePanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockGetState.mockResolvedValue({ operation: null, catalog });
    mockReview.mockResolvedValue(quote());
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn()
        .mockReturnValueOnce(OPERATION_ID)
        .mockReturnValueOnce(NEXT_OPERATION_ID),
    });
  });

  it("renders only after the server confirms the allocated Hetzner resize capability", async () => {
    const { ProviderResizeApiError } = jest.requireMock("@/lib/hivra/agent-api") as {
      ProviderResizeApiError: new (code: string, message: string) => Error;
    };
    mockGetState.mockRejectedValue(new ProviderResizeApiError("not_supported", "Not supported"));
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    await waitFor(() => expect(mockGetState).toHaveBeenCalledWith(AGENT_ID));
    expect(screen.queryByTestId("provider-resize-panel")).not.toBeInTheDocument();
  });

  it("continues an already-confirmed shutdown once and never automatically repeats an uncertain POST", async () => {
    const saved = quote();
    mockGetState.mockResolvedValue({ catalog: null, operation: {
      operationId: OPERATION_ID, stage: "provider_pending", quote: saved,
      providerActionId: 701, providerActionStatus: "success", observedProviderState: "running",
      observedServerType: "cpx32", completedAt: null, shutdownRequired: true,
      message: "Hetzner started the resized computer.",
    } });
    mockConfirm.mockRejectedValue(new Error("The original shutdown response is uncertain."));
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("original shutdown response is uncertain");
    expect(mockConfirm).toHaveBeenCalledWith({ agentId: AGENT_ID, operationId: OPERATION_ID,
      quoteFingerprint: saved.quoteFingerprint });
    fireEvent.click(screen.getByRole("button", { name: "Check Hetzner status" }));
    await waitFor(() => expect(mockGetState).toHaveBeenCalledTimes(2));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue saved resize" })).toBeEnabled();
  });

  it("keeps the automatic continuation available until the server verifies readiness", async () => {
    const waiting = { operationId: OPERATION_ID, stage: "provider_pending", quote: quote(),
      providerActionId: 701, providerActionStatus: "success", observedProviderState: "running",
      observedServerType: "cpx32", completedAt: null, shutdownRequired: false,
      shutdownReadinessWaiting: true, message: "Waiting for the enrolled shutdown listener." };
    mockGetState.mockResolvedValue({ catalog: null, operation: waiting });
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Waiting for the enrolled shutdown listener");
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue saved resize" })).not.toBeInTheDocument();
    mockGetState.mockResolvedValue({ catalog: null, operation: { ...waiting, shutdownRequired: true, shutdownReadinessWaiting: false } });
    mockConfirm.mockResolvedValueOnce(waiting); // Fresh probe found early boot; no marker consumed.
    fireEvent.click(screen.getByRole("button", { name: "Check Hetzner status" }));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check Hetzner status" })).toBeEnabled());
    mockConfirm.mockResolvedValueOnce({ ...waiting, shutdownReadinessWaiting: false, message: "Original shutdown is being checked." });
    fireEvent.click(screen.getByRole("button", { name: "Check Hetzner status" }));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(2));
    expect(mockReview).not.toHaveBeenCalled();
  });

  it("labels live figures as server-plan prices and excludes separate IPv4/resource charges", async () => {
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review price & downtime" }));

    expect(await screen.findByText(/Current server-plan price/)).toHaveTextContent("EUR 5.95/month");
    expect(screen.getByText(/These figures are for the server plan only/)).toHaveTextContent(
      "existing IPv4 and other separately billed Hetzner resources are excluded here and keep their separate charges",
    );
    expect(screen.getByText(/These figures are for the server plan only/)).toHaveTextContent(
      "existing 80 GB disk is retained exactly as-is; Hivra does not enlarge it",
    );
    const apply = screen.getByRole("button", { name: "Resize on Hetzner" });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept the new Hetzner billing/ }));
    expect(apply).toBeEnabled();
  });

  it("removes decimal padding without rounding quoted prices or changing consent", async () => {
    const padded = { ...target, price: { currency: "USD", monthlyGross: "27.5880000000000000", hourlyGross: "0.0441600000000000" } };
    mockGetState.mockResolvedValue({ operation: null, catalog: { ...catalog, offers: [padded] } });
    mockReview.mockResolvedValue({ ...quote(), target: padded });
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    expect(await screen.findByRole("option")).toHaveTextContent("USD 27.588/month server plan");
    fireEvent.click(screen.getByRole("button", { name: "Review price & downtime" }));
    expect(await screen.findByText(/New server-plan price/)).toHaveTextContent("USD 27.588/month · USD 0.04416/hour");
    expect(screen.getByRole("button", { name: "Resize on Hetzner" })).toBeDisabled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("expires an untouched review on a bounded timer and requires a fresh operation review", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    mockReview.mockResolvedValue(quote("2026-09-04T14:01:00.000Z"));
    render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Review price & downtime" }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept the new Hetzner billing/ }));
    expect(screen.getByRole("button", { name: "Resize on Hetzner" })).toBeEnabled();

    act(() => { jest.advanceTimersByTime(60_100); });

    expect(screen.queryByRole("button", { name: "Resize on Hetzner" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("price review expired");
    fireEvent.click(screen.getByRole("button", { name: "Review price & downtime" }));
    await act(async () => Promise.resolve());
    expect(mockReview.mock.calls[0][0].operationId).toBe(OPERATION_ID);
    expect(mockReview.mock.calls[1][0].operationId).toBe(NEXT_OPERATION_ID);
  });

  it("drops a stale reviewed target when a fresh catalog makes it the current plan", async () => {
    const view = render(<ProviderResizePanel agent={agent} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review price & downtime" }));
    expect(await screen.findByText(/Current server-plan price/)).toBeInTheDocument();

    const next = {
      ...target,
      serverTypeId: 3,
      serverType: "cpx42",
      cores: 8,
      memoryGb: 16,
      advertisedDiskGb: 240,
      price: { ...target.price, monthlyGross: "23.80" },
    };
    mockGetState.mockResolvedValue({ operation: null, catalog: {
      ...catalog,
      current: target,
      offers: [{ ...next, description: "CPX42" }],
    } });
    view.rerender(<ProviderResizePanel agent={{ ...agent, resize_stage: "succeeded" }} onChanged={jest.fn()} />);

    await waitFor(() => expect(screen.getByRole("combobox", { name: "Server type" })).toHaveValue("cpx42"));
    expect(screen.queryByText(/Current server-plan price/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review price & downtime" }));
    await waitFor(() => expect(mockReview).toHaveBeenLastCalledWith(expect.objectContaining({ targetServerType: "cpx42" })));
  });
});
