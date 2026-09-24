/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockConnect = jest.fn();
const mockReplace = jest.fn();
const mockSetExpiry = jest.fn();

jest.mock("@/lib/hivra/managed-session-client", () => {
  const actual = jest.requireActual("@/lib/hivra/managed-session-client");
  return {
    ...actual,
    connectDigitalOceanAccount: (...args: unknown[]) => mockConnect(...args),
    replaceDigitalOceanAccountToken: (...args: unknown[]) => mockReplace(...args),
    setDigitalOceanAccountTokenExpiry: (...args: unknown[]) => mockSetExpiry(...args),
  };
});

import { DigitalOceanConnectionCard } from "../DigitalOceanConnectionCard";
import { DigitalOceanConnectionDialog } from "../DigitalOceanConnectionDialog";
import type { DigitalOceanConnectionDto, DigitalOceanDeploymentTargetDto } from "@/lib/infrastructure/contracts";

const CONNECTION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "dop_v1_" + "a".repeat(64);

function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const baseConnection = {
  id: CONNECTION, name: "My DigitalOcean team", provider: "digitalocean", operatingMode: "self-managed",
  setupMode: "simple", status: "ready", endpoint: null, configuration: null,
  capabilities: { inventory: false, offerCatalog: false, createCapacity: false, agentLaunch: true, reason: "x" },
  credentialsConfigured: true, lastCheckedAt: "2026-09-24T00:00:00.000Z", lastErrorCode: null,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
} as unknown as DigitalOceanConnectionDto;
const target = { id: "t1", connectionId: CONNECTION, status: "ready", capabilities: { sizes: ["mars-1vcpu-1gb"] } } as unknown as DigitalOceanDeploymentTargetDto;

function card(connection: Partial<DigitalOceanConnectionDto>, onExpiryChanged = jest.fn()) {
  render(
    <DigitalOceanConnectionCard
      connection={{ ...baseConnection, ...connection } as DigitalOceanConnectionDto}
      target={target}
      sessions={[]}
      refreshing={false}
      onLaunch={jest.fn()}
      onRefresh={jest.fn()}
      onReplaceToken={jest.fn()}
      onDelete={jest.fn()}
      onExpiryChanged={onExpiryChanged}
    />,
  );
  return onExpiryChanged;
}

beforeEach(() => {
  for (const mock of [mockConnect, mockReplace, mockSetExpiry]) mock.mockReset();
});

describe("DigitalOceanConnectionCard token expiry", () => {
  it("shows one expiring badge, the date, and a banner a week ahead", () => {
    card({ credentialExpiry: { source: "owner-declared", noExpiry: false, expiresOn: isoDaysFromNow(5), declaredAt: "2026-09-01T00:00:00.000Z" } });
    expect(screen.getByText("Token expires in 5 days")).toBeInTheDocument();
    expect(screen.getByText(/Replace it now so your agents keep working/)).toBeInTheDocument();
    expect(screen.queryByText("Ready for agents")).not.toBeInTheDocument();
  });

  it("puts a rejected token ahead of any date and stays ready when there is no expiry", () => {
    card({ status: "error", lastErrorCode: "invalid_credentials", credentialExpiry: { source: "owner-declared", noExpiry: false, expiresOn: isoDaysFromNow(2), declaredAt: "2026-09-01T00:00:00.000Z" } });
    expect(screen.getByText("Token rejected")).toBeInTheDocument();
  });

  it("stays Ready for agents with no expiry", () => {
    card({ credentialExpiry: { source: "owner-declared", noExpiry: true, expiresOn: null, declaredAt: "2026-09-01T00:00:00.000Z" } });
    expect(screen.getByText("Ready for agents")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
  });

  it("lets the owner record a reminder for an older connection", async () => {
    const saved = { source: "owner-declared", noExpiry: true, expiresOn: null, declaredAt: "2026-09-24T00:00:00.000Z" };
    mockSetExpiry.mockResolvedValueOnce(saved);
    const onExpiryChanged = card({ credentialExpiry: null });
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    fireEvent.click(screen.getByRole("button", { name: /Save reminder/ }));
    await waitFor(() => expect(onExpiryChanged).toHaveBeenCalledWith(saved));
    expect(mockSetExpiry).toHaveBeenCalledWith(CONNECTION, { mode: "none" });
  });
});

describe("DigitalOceanConnectionDialog token expiry", () => {
  it("sends the chosen expiry with a new connection", async () => {
    mockConnect.mockResolvedValueOnce({ connection: baseConnection, target });
    render(<DigitalOceanConnectionDialog onClose={jest.fn()} onConnected={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/DigitalOcean personal access token/), { target: { value: TOKEN } });
    fireEvent.change(screen.getByLabelText("When does this token expire?"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect DigitalOcean/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    expect(mockConnect.mock.calls[0][0]).toMatchObject({ tokenExpiry: { mode: "none" }, credentials: { apiToken: TOKEN } });
  });

  it("records nothing for Not sure and requires a date for On a date", async () => {
    mockReplace.mockResolvedValue({ connection: baseConnection, target });
    render(<DigitalOceanConnectionDialog replacing={baseConnection} onClose={jest.fn()} onConnected={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/DigitalOcean personal access token/), { target: { value: TOKEN } });
    fireEvent.change(screen.getByLabelText("When does this token expire?"), { target: { value: "date" } });
    fireEvent.click(screen.getByRole("button", { name: /Replace token/ }));
    expect(await screen.findByText(/Choose the date DigitalOcean shows/)).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("When does this token expire?"), { target: { value: "unknown" } });
    fireEvent.click(screen.getByRole("button", { name: /Replace token/ }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(CONNECTION, TOKEN, undefined));
  });
});
