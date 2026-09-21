/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseLaunchTargetHandoff } from "../launch-target-handoff";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import { listInfrastructureTargets } from "@/lib/infrastructure/client";
import {
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  DeploymentDestinationControl,
  deploymentForTarget,
  measuredTargetCapacity,
  useLaunchDestination,
} from "../DeploymentDestinationControl";

jest.mock("@/lib/infrastructure/client", () => ({
  listInfrastructureTargets: jest.fn(),
}));

const TARGET: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: "11111111-1111-4111-8111-111111111111",
  evidenceConnectionRevision: 7,
  externalId: "pve-01",
  displayName: "Studio Proxmox / pve-01",
  status: "ready",
  capacity: {
    cpu: { totalCores: 6, utilizationRatio: 0.2 },
    memoryBytes: { total: 16 * 1024 ** 3, available: 7.75 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 350 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: true,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr1"],
    selectedBridge: "vmbr1",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
    provisioner: {
      configured: true,
      ready: true,
      version: PORTABLE_HIVRA_PROVISIONER_VERSION,
    },
    runtimeCompatibility: {
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
      supportedCatalogRuntimeIds: [
        ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY.supportedCatalogRuntimeIds,
      ],
    },
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-08-26T12:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function Harness({
  runtimeId = "codex",
  hints = [],
  preferSelfManaged = false,
  capacitySetupHref,
}: {
  runtimeId?: string;
  hints?: string[];
  preferSelfManaged?: boolean;
  capacitySetupHref?: string;
}) {
  const state = useLaunchDestination(runtimeId, {
    handoff: parseLaunchTargetHandoff(hints),
    preferSelfManaged,
  });
  return (
    <>
      <DeploymentDestinationControl
        state={state}
        runtimeName="Codex"
        capacitySetupHref={capacitySetupHref}
      />
      <output data-testid="deployment">{JSON.stringify(state.deployment)}</output>
    </>
  );
}

describe("DeploymentDestinationControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([TARGET]);
  });

  it("offers an admitted provider computer with explicit whole-computer and native-sign-in boundaries", async () => {
    const target = providerVmTarget(); target.status = "ready"; target.lastErrorCode = null;
    target.capabilities.launchReady = true; target.capabilities.provisioner.ready = true;
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([target]);
    render(<Harness />);
    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled()); fireEvent.click(selfManaged);
    expect(screen.getByLabelText("Ready host")).toHaveValue(target.id);
    expect(screen.getByText(/uses the entire prepared cloud computer/)).toBeInTheDocument();
    expect(screen.getByTestId("deployment")).toHaveTextContent(target.id);
  });
  it.each(["2026.09.07.1",PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION])("uses exact provider bundle %s for Ubuntu placement",async version=>{
    const target=providerVmTarget();target.status="ready";target.lastErrorCode=null;
    target.capabilities.launchReady=true;target.capabilities.provisioner.ready=true;target.capabilities.provisioner.version=version;
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([target]);
    render(<Harness runtimeId="linux-desktop" preferSelfManaged />);
    await waitFor(()=>expect(listInfrastructureTargets).toHaveBeenCalled());
    if(version===PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION)await waitFor(()=>expect(screen.getByTestId("deployment")).toHaveTextContent(target.id));
    else await waitFor(()=>expect(screen.getByRole("button",{name:/My infrastructure/i})).toBeDisabled());
  });

  it("defaults to Hivra Cloud and builds an exact revision-bound target payload", async () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: /Hivra Cloud/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("deployment")).toHaveTextContent('{"mode":"hivra-managed"}');

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    fireEvent.click(selfManaged);

    expect(screen.getByLabelText("Ready host")).toHaveValue(TARGET.id);
    expect(screen.getByText("Studio Proxmox / pve-01")).toBeInTheDocument();
    expect(screen.getByTestId("deployment")).toHaveTextContent(
      JSON.stringify({
        mode: "self-managed",
        connectionId: TARGET.connectionId,
        targetId: TARGET.id,
        expectedConnectionRevision: 7,
      }),
    );
  });

  it("can default hosted launch to ready self-managed capacity", async () => {
    render(<Harness preferSelfManaged />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    expect(selfManaged).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("deployment")).toHaveTextContent(`"targetId":"${TARGET.id}"`);
  });

  it("defaults a standalone installation to its connected host and removes Hivra Cloud", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    try {
      render(<Harness />);

      expect(screen.queryByRole("button", { name: /Hivra Cloud/i })).not.toBeInTheDocument();
      const connectedHost = await screen.findByRole("button", { name: /Connected host/i });
      await waitFor(() => expect(connectedHost).toBeEnabled());
      expect(connectedHost).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByLabelText("Ready host")).toHaveValue(TARGET.id);
      expect(screen.getByTestId("deployment")).toHaveTextContent(`"targetId":"${TARGET.id}"`);
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });

  it("selects the handed-off computer, not the first host, using fresh revision evidence", async () => {
    const other = { ...TARGET, id: "33333333-3333-4333-8333-333333333333" };
    (listInfrastructureTargets as jest.Mock).mockResolvedValue([other, { ...TARGET, evidenceConnectionRevision: 12 }]);
    render(<Harness hints={[TARGET.id]} />);
    expect(screen.getByTestId("deployment")).toHaveTextContent("null");
    expect(screen.getByRole("button", { name: /My infrastructure/i })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByTestId("deployment")).toHaveTextContent(`"targetId":"${TARGET.id}"`));
    expect(screen.getByTestId("deployment")).toHaveTextContent('"expectedConnectionRevision":12');
    fireEvent.change(screen.getByLabelText("Ready host"), { target: { value: other.id } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    expect(screen.getByTestId("deployment")).toHaveTextContent(other.id);
    fireEvent.click(screen.getByRole("button", { name: /Hivra Cloud/i }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    expect(screen.getByTestId("deployment")).toHaveTextContent('{"mode":"hivra-managed"}');
  });

  it.each([[""], ["invalid"], [TARGET.id, TARGET.id], ["99999999-9999-4999-8999-999999999999"]])(
    "keeps unavailable or malformed handoff %j blocked through repeated refreshes", async (...hints) => {
      render(<Harness hints={hints} />);
      for (let pass = 0; pass < 3; pass++) {
        await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
        expect(screen.getByTestId("deployment")).toHaveTextContent("null");
        expect(screen.getByRole("button", { name: /My infrastructure/i })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));
      }
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    },
  );

  it("invalidates old runtime/navigation evidence immediately and ignores late responses", async () => {
    let resolveLate!: (targets: DeploymentTargetDto[]) => void;
    (listInfrastructureTargets as jest.Mock).mockResolvedValueOnce([TARGET])
      .mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }))
      .mockResolvedValueOnce([]);
    const view = render(<Harness hints={[TARGET.id]} />);
    await waitFor(() => expect(screen.getByTestId("deployment")).toHaveTextContent(TARGET.id));
    view.rerender(<Harness hints={[TARGET.id]} runtimeId="openclaw" />);
    expect(screen.getByTestId("deployment")).toHaveTextContent("null");
    view.rerender(<Harness hints={["99999999-9999-4999-8999-999999999999"]} runtimeId="openclaw" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    await act(async () => resolveLate([TARGET]));
    expect(screen.getByTestId("deployment")).toHaveTextContent("null");
  });

  it("fails closed without silently changing the payload when selected evidence disappears", async () => {
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([TARGET])
      .mockResolvedValueOnce([]);
    render(<Harness />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    fireEvent.click(selfManaged);
    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));

    await waitFor(() => expect(screen.getByTestId("deployment")).toHaveTextContent("null"));
    expect(selfManaged).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/No self-managed host is ready yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Infrastructure" })).toHaveAttribute(
      "href",
      "/dashboard/infrastructure",
    );
  });

  it("does not silently replace a selected computer with another ready target", async () => {
    const replacement: DeploymentTargetDto = {
      ...TARGET,
      id: "33333333-3333-4333-8333-333333333333",
      connectionId: "44444444-4444-4444-8444-444444444444",
      displayName: "Backup Proxmox / pve-02",
      externalId: "pve-02",
      evidenceConnectionRevision: 4,
    };
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([TARGET, replacement])
      .mockResolvedValue([replacement]);
    render(<Harness />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    fireEvent.click(selfManaged);
    expect(screen.getByLabelText("Ready host")).toHaveValue(TARGET.id);

    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));

    await waitFor(() => expect(screen.getByTestId("deployment")).toHaveTextContent("null"));
    expect(screen.getByLabelText("Ready host")).toHaveValue("");
    expect(screen.getByText(/previously selected host is no longer ready for this agent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    expect(screen.getByTestId("deployment")).toHaveTextContent("null");

    fireEvent.change(screen.getByLabelText("Ready host"), {
      target: { value: replacement.id },
    });
    expect(screen.getByTestId("deployment")).toHaveTextContent(replacement.id);
  });

  it("invalidates a self-managed payload while refreshed evidence is still pending", async () => {
    (listInfrastructureTargets as jest.Mock)
      .mockResolvedValueOnce([TARGET])
      .mockImplementationOnce(() => new Promise(() => undefined));
    render(<Harness />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    fireEvent.click(selfManaged);
    expect(screen.getByTestId("deployment")).toHaveTextContent(TARGET.id);

    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));

    expect(screen.getByTestId("deployment")).toHaveTextContent("null");
    expect(screen.getByRole("region", { name: "Where it runs" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("announces target discovery instead of presenting loading as an empty registry", () => {
    (listInfrastructureTargets as jest.Mock).mockImplementation(() => new Promise(() => undefined));
    render(<Harness />);

    expect(screen.getByRole("region", { name: "Where it runs" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      screen.getByText("Checking your ready hosts...").closest('[role="status"]'),
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText(/No self-managed host is ready yet/i)).not.toBeInTheDocument();
  });

  it("disables self-managed placement when ready evidence excludes the selected runtime", async () => {
    (listInfrastructureTargets as jest.Mock).mockResolvedValueOnce([{
      ...TARGET,
      capabilities: {
        ...TARGET.capabilities,
        runtimeCompatibility: {
          contractVersion: 1,
          provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
          supportedCatalogRuntimeIds: ["claude-code"],
        },
      },
    }]);
    render(<Harness capacitySetupHref="/dashboard/infrastructure?launch=codex" />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeDisabled());
    expect(screen.getByText(/none of your ready hosts.*compatibility evidence for Codex/i))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Infrastructure" })).toHaveAttribute(
      "href",
      "/dashboard/infrastructure?launch=codex",
    );
    expect(screen.getByTestId("deployment")).toHaveTextContent('{"mode":"hivra-managed"}');
  });

  it("fails closed when compatibility and observed evidence match an older provisioner", async () => {
    (listInfrastructureTargets as jest.Mock).mockResolvedValueOnce([{
      ...TARGET,
      capabilities: {
        ...TARGET.capabilities,
        provisioner: {
          ...TARGET.capabilities.provisioner!,
          version: "2026.08.26.4",
        },
        runtimeCompatibility: {
          ...TARGET.capabilities.runtimeCompatibility!,
          provisionerVersion: "2026.08.26.4",
        },
      },
    }]);
    render(<Harness />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeDisabled());
    expect(screen.getByText(/inspect, and prepare a host/i)).toBeInTheDocument();
    expect(screen.getByTestId("deployment")).toHaveTextContent('{"mode":"hivra-managed"}');
  });

  it("fails closed when ready target evidence predates runtime compatibility", async () => {
    const legacyCapabilities = { ...TARGET.capabilities } as Record<string, unknown>;
    delete legacyCapabilities.runtimeCompatibility;
    (listInfrastructureTargets as jest.Mock).mockResolvedValueOnce([{
      ...TARGET,
      capabilities: legacyCapabilities,
    }]);
    render(<Harness />);

    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeDisabled());
    expect(screen.getByText(/inspect, and prepare a host/i)).toBeInTheDocument();
    expect(screen.getByTestId("deployment")).toHaveTextContent('{"mode":"hivra-managed"}');
  });

  it("derives selectable resources only from measured target capacity", () => {
    expect(measuredTargetCapacity(TARGET)).toEqual({ cpu: 6, ramGb: 7 });
    expect(deploymentForTarget(TARGET)).toEqual({
      mode: "self-managed",
      connectionId: TARGET.connectionId,
      targetId: TARGET.id,
      expectedConnectionRevision: TARGET.evidenceConnectionRevision,
    });
    expect(deploymentForTarget(null)).toBeNull();
  });
});
