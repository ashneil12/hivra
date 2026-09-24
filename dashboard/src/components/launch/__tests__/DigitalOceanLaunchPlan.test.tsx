/** @jest-environment jsdom */
// Review of INF-16: a choice that had confirmed a saved Vault key, whose key
// is then gone from the list (deleted, or the Vault didn't load), shows only
// the paste field. A key typed there must replace the saved one; before, the
// choice stayed on "saved" and the launch sent the stale saved key instead.

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { DEFAULT_DIGITALOCEAN_CHOICE } from "@/lib/launch/contracts";
import { DigitalOceanDeploymentTargetDtoSchema, DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION } from "@/lib/infrastructure/contracts";
import { DigitalOceanLaunchPlan } from "../DigitalOceanLaunchPlan";

jest.mock("@/lib/hivra/managed-session-client", () => ({
  ...jest.requireActual("@/lib/hivra/managed-session-client"),
  listDigitalOceanModels: jest.fn(() => new Promise(() => undefined)),
}));

const TEAM = DigitalOceanDeploymentTargetDtoSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: "11111111-1111-4111-8111-111111111111",
  evidenceConnectionRevision: 3,
  externalId: "do-harness-runtime",
  displayName: "Studio team",
  status: "ready",
  capacity: { model: "serverless-sessions", sizes: [{ slug: "mars-2vcpu-4gb", vcpus: 2, memoryMb: 4096 }] },
  capabilities: {
    kind: "digitalocean-managed-agents", launchReady: true,
    adapter: { version: DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION },
    harnesses: ["codex"], sizes: ["mars-2vcpu-4gb"],
    access: { chat: "hivra-relay-v1", approvals: "hivra-relay-v1", terminal: false, publicPorts: false },
    desktop: false, windows: false,
  },
  supportedIsolationDrivers: ["do-harness-microvm"],
  isolationClass: "provider-microvm",
  lastPreflightAt: "2026-09-24T10:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
});

it("takes a key typed after the confirmed saved key is gone, and drops the saved key's consent", () => {
  const onChange = jest.fn();
  render(
    <DigitalOceanLaunchPlan
      target={TEAM}
      harness="codex"
      agentName="Codex 1"
      choice={{ ...DEFAULT_DIGITALOCEAN_CHOICE, keySource: "saved", vaultKeyId: "44444444-4444-4444-8444-444444444444", sendSavedKey: true }}
      onChange={onChange}
      pastedKey=""
      onPastedKeyChange={jest.fn()}
      savedKeys={[]}
      problem={null}
      balance={{ balance: null, error: null, checking: false, recheck: jest.fn() }}
    />,
  );

  expect(screen.queryByRole("group", { name: "Which key" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-test-openai-key-for-launch-0000" } });
  expect(onChange).toHaveBeenCalledWith({ keySource: "paste", sendSavedKey: false });
});
