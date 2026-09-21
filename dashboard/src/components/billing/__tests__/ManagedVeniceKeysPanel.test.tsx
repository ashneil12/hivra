/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

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

    expect(screen.getByText("Managed Venice proxy keys")).toBeInTheDocument();
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
