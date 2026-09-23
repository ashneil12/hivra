/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ManagedVeniceKeysPanel } from "../ManagedVeniceKeysPanel";

describe("ManagedVeniceKeysPanel", () => {
  it("shows key prefixes and statuses without plaintext", () => {
    render(
      <ManagedVeniceKeysPanel
        keys={[
          {
            id: "key_1",
            name: "Production key",
            keyPrefix: "hven_live_abcd",
            status: "active",
            createdAt: "2026-05-12T12:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
          },
        ]}
      />
    );

    expect(screen.getByText("Keys your agents use for model credits")).toBeInTheDocument();
    expect(screen.getByText("Production key")).toBeInTheDocument();
    expect(screen.getByText("hven_live_abcd...")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.queryByText(/plaintext_secret/i)).not.toBeInTheDocument();
  });

  it("shows created plaintext once when supplied by the create response", () => {
    render(
      <ManagedVeniceKeysPanel
        keys={[]}
        createdPlaintextKey="hven_live_plaintext_secret"
      />
    );

    expect(screen.getByText("hven_live_plaintext_secret")).toBeInTheDocument();
    expect(screen.getByText("Shown once. Store it before leaving this page.")).toBeInTheDocument();
  });
});

describe("ManagedVeniceKeysPanel revoked keys", () => {
  const key = (overrides: Partial<Parameters<typeof ManagedVeniceKeysPanel>[0]["keys"][number]>) => ({
    id: "key",
    name: "Key",
    keyPrefix: "hven_live_0000",
    status: "active",
    createdAt: "2026-05-12T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  });

  it("shows active and paused keys and folds revoked keys behind 'Show N revoked keys'", () => {
    render(
      <ManagedVeniceKeysPanel
        keys={[
          key({ id: "a", name: "Production key", status: "active" }),
          key({ id: "p", name: "Paused key", status: "paused" }),
          key({ id: "r1", name: "Old laptop", status: "revoked", revokedAt: "2026-06-01T00:00:00.000Z" }),
          key({ id: "r2", name: "Leaked key", status: "revoked", revokedAt: "2026-06-02T00:00:00.000Z" }),
        ]}
      />
    );

    expect(screen.getByText("Production key")).toBeInTheDocument();
    expect(screen.getByText("Paused key")).toBeInTheDocument();
    expect(screen.queryByText("Old laptop")).not.toBeInTheDocument();
    expect(screen.queryByText("Leaked key")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Show 2 revoked keys" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide revoked keys");
    const revokedList = screen.getByRole("list", { name: "Revoked keys" });
    expect(toggle).toHaveAttribute("aria-controls", revokedList.id);
    expect(within(revokedList).getByText("Old laptop")).toBeInTheDocument();
    expect(within(revokedList).getByText("Leaked key")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText("Old laptop")).not.toBeInTheDocument();
  });

  it("uses the singular for one revoked key and says when nothing is active", () => {
    render(<ManagedVeniceKeysPanel keys={[key({ id: "r", name: "Old key", status: "revoked" })]} />);
    expect(screen.getByText("No active keys.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 1 revoked key" })).toBeInTheDocument();
  });

  it("treats a key with a revocation time as revoked even if its status lags", () => {
    render(
      <ManagedVeniceKeysPanel
        keys={[key({ id: "x", name: "Lagging key", status: "active", revokedAt: "2026-06-01T00:00:00.000Z" })]}
      />
    );
    expect(screen.queryByText("Lagging key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 1 revoked key" })).toBeInTheDocument();
  });

  it("has no revoked toggle when nothing is revoked, and says when a key was never used", () => {
    render(<ManagedVeniceKeysPanel keys={[key({ id: "a", name: "Fresh key" })]} />);
    expect(screen.queryByRole("button", { name: /revoked/i })).not.toBeInTheDocument();
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  it("offers a copy button for a newly created key", () => {
    render(<ManagedVeniceKeysPanel keys={[]} createdPlaintextKey="hven_live_plaintext_secret" />);
    expect(screen.getByRole("button", { name: /copy key/i })).toBeInTheDocument();
  });
});
