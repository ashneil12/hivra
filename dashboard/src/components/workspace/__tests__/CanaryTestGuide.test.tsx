/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";

import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import type { ReleaseMetadata } from "@/lib/workspace/release-metadata";
import type { ReleaseAgentDetailLoader } from "@/lib/workspace/release-capability-matrix";
import { CanaryTestGuide, FIVE_MINUTE_WORKFLOW } from "../CanaryTestGuide";
import { WorkspaceHeader } from "../WorkspaceHeader";
import { WorkspaceModalLayerProvider } from "../WorkspaceModalLayerContext";

const SECRET = "sk_live_DO_NOT_LEAK_123456789";
const metadata: ReleaseMetadata = {
  canaryUrl: "https://canary.hivra.cloud/dashboard/workspace",
  revision: "0123456789abcdef0123456789abcdef01234567",
  shortRevision: "0123456789ab",
  deploymentId: "dpl_5D31bGmGqVxRszYBHh6yW3nM9K2p",
  targetEnvironment: "preview",
  buildGeneratedAt: "2026-08-24T20:15:30.000Z",
  buildGeneratedAtLabel: "Build generated at",
};

function agent(
  kind: "hermes" | "hivra",
  id: string,
  name: string,
): UnifiedAgent {
  return {
    uid: `${kind === "hermes" ? "h" : "x"}-${id}`,
    kind,
    id,
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "OpenAI",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
    agentType: kind === "hermes" ? null : "codex",
  };
}

const hermes = agent("hermes", `private-${SECRET}`, `Hermes name ${SECRET}`);
const hivra = agent("hivra", "hivra-private-id", "Hivra private name");

const loadDetail: ReleaseAgentDetailLoader = async (selected) => {
  if (selected.kind === "hermes") {
    return {
      kind: "hermes",
      uid: selected.uid,
      instance: {
        id: selected.id,
        name: selected.name,
        status: "running",
        backend: "gateway",
        gateway_url: `https://gateway.internal/?token=${SECRET}#private`,
        error: `raw error ${SECRET}`,
      },
    };
  }
  return {
    kind: "hivra",
    uid: selected.uid,
    agent: {
      id: selected.id,
      name: selected.name,
      status: "running",
      type: "codex",
      chat_url: "https://agent.internal",
      api_token: SECRET,
      transcript: `private transcript ${SECRET}`,
    },
    browserEnabled: true,
  };
};

describe("CanaryTestGuide", () => {
  const originalClipboard = navigator.clipboard;
  const originalMatchMedia = window.matchMedia;
  const writeText = jest.fn<Promise<void>, [string]>();

  beforeEach(() => {
    jest.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: false,
        media: "(display-mode: standalone)",
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }),
    });
  });

  afterAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("renders every handoff section with exact provenance, limitations, Mac steps, workflow, and feedback", async () => {
    render(
      <CanaryTestGuide
        open
        onClose={jest.fn()}
        releaseMetadata={metadata}
        agents={[hermes, hivra]}
        loadAgentDetail={loadDetail}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Canary test guide" });
    expect(dialog.className).toContain(
      "min-[1200px]:w-[min(920px,calc(100vw-64px))]",
    );
    expect(dialog.parentElement?.className).toContain("min-[1200px]:justify-center");
    for (const heading of [
      "Canary URL",
      "Git revision",
      "Build provenance",
      "Capability matrix",
      "Known limitations",
      "Install Hivra on Mac",
      "Five-minute workflow",
      "Feedback",
    ]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    expect(within(dialog).getByText(metadata.canaryUrl)).toBeInTheDocument();
    expect(within(dialog).getByText(metadata.revision)).toBeInTheDocument();
    expect(within(dialog).getByText(metadata.shortRevision)).toBeInTheDocument();
    expect(within(dialog).getByText("Build generated at")).toBeInTheDocument();
    expect(within(dialog).getByText(metadata.buildGeneratedAt)).toBeInTheDocument();
    expect(within(dialog).queryByText(/deployed at|ready at/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/build-generation provenance only/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/compatibility sessions.*no canonical run acknowledgement/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/short-lived tenant-scoped grants arrive in Phase 3/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Safari.*File.*Add to Dock/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Chrome or Edge.*Install Hivra.*Add to Dock/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/same authenticated workspace/i)).toBeInTheDocument();

    for (const step of FIVE_MINUTE_WORKFLOW) {
      expect(within(dialog).getAllByText(step).length).toBeGreaterThanOrEqual(1);
    }
    expect(within(dialog).getByRole("heading", { name: "Your test checklist" })).toBeInTheDocument();
    expect(within(dialog).getByText("Send feedback")).toBeInTheDocument();
    expect(within(dialog).getByTestId("report-problem-link")).toHaveAttribute(
      "href",
      expect.stringMatching(/^mailto:/),
    );

    expect(await within(dialog).findByText("Hermes agent 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Hivra agent 1")).toBeInTheDocument();
  });

  it("registers the guide with the global workspace modal layer", async () => {
    const onActiveChange = jest.fn();
    const guide = (open: boolean) => (
      <WorkspaceModalLayerProvider onActiveChange={onActiveChange}>
        <CanaryTestGuide
          open={open}
          onClose={jest.fn()}
          releaseMetadata={metadata}
          agents={[]}
          loadAgentDetail={loadDetail}
        />
      </WorkspaceModalLayerProvider>
    );
    const { rerender } = render(guide(true));

    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(true));
    rerender(guide(false));
    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
  });

  it("shows every mixed/partial row and copies unknown as unknown, never supported", async () => {
    const partialLoader: ReleaseAgentDetailLoader = async (selected, signal) => {
      if (selected.kind === "hivra") {
        throw new Error(`raw URL https://private.invalid/?token=${SECRET}#fragment`);
      }
      return loadDetail(selected, signal);
    };
    const { container } = render(
      <CanaryTestGuide
        open
        onClose={jest.fn()}
        releaseMetadata={metadata}
        agents={[hermes, hivra]}
        loadAgentDetail={partialLoader}
      />,
    );

    expect(await screen.findByText("Hermes agent 1")).toBeInTheDocument();
    expect(screen.getByText("Hivra agent 1")).toBeInTheDocument();
    const hivraRow = screen.getByTestId("release-capability-hivra-1");
    expect(hivraRow).toHaveTextContent("Detail unknown");
    expect(hivraRow).toHaveTextContent("WorkspaceUnknown");

    fireEvent.click(screen.getByRole("button", { name: "Copy test details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0];

    expect(copied).toContain("Hermes agent 1");
    expect(copied).toContain("Hivra agent 1 — detail unknown (detail-unavailable)");
    expect(copied).not.toMatch(/Hivra agent 1.*supported/i);
    for (const forbidden of [
      SECRET,
      hermes.uid,
      hermes.name,
      hivra.uid,
      hivra.name,
      "private.invalid",
      "raw URL",
      "?token=",
      "#fragment",
      "transcript",
    ]) {
      expect(container.textContent).not.toContain(forbidden);
      expect(copied).not.toContain(forbidden);
    }
  });

  it("copies only the exact allowlisted URL and full revision", async () => {
    render(
      <CanaryTestGuide
        open
        onClose={jest.fn()}
        releaseMetadata={{
          ...metadata,
          secret: SECRET,
          queryUrl: `https://canary.hivra.cloud/?token=${SECRET}`,
        } as ReleaseMetadata}
        agents={[]}
        loadAgentDetail={loadDetail}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(metadata.canaryUrl));
    fireEvent.click(screen.getByRole("button", { name: "Copy revision" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(metadata.revision));

    expect(writeText.mock.calls.flat().join("\n")).not.toContain(SECRET);
  });

  it("keeps checklist state user-controlled and copies it without a percentage or acceptance claim", async () => {
    render(
      <CanaryTestGuide
        open
        onClose={jest.fn()}
        releaseMetadata={metadata}
        agents={[]}
        loadAgentDetail={loadDetail}
      />,
    );
    const firstCheckbox = screen.getByRole("checkbox", {
      name: FIVE_MINUTE_WORKFLOW[0],
    });

    expect(firstCheckbox).not.toBeChecked();
    fireEvent.click(firstCheckbox);
    expect(firstCheckbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Copy test details" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0];

    expect(copied).toContain(`[x] ${FIVE_MINUTE_WORKFLOW[0]}`);
    expect(copied).toContain(`[ ] ${FIVE_MINUTE_WORKFLOW[1]}`);
    expect(copied).not.toMatch(/\d+%|canonical acceptance|server-verified/i);
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it("closes on Escape and leaves the header free of the guide trigger", () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <CanaryTestGuide
        open
        onClose={onClose}
        releaseMetadata={metadata}
        agents={[]}
        loadAgentDetail={loadDetail}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The guide used to be a bare book glyph in the workspace header, with no
    // visible label anywhere. Its meaning was unrecoverable, so it moved into
    // the agent menu's footer where it is written out as "Test guide".
    rerender(
      <WorkspaceHeader
        agent={hermes}
        headingRef={createRef()}
        agentPickerTriggerRef={createRef()}
        agentPickerOpen={false}
        surfaceSelected={false}
        onToggleAgentPane={jest.fn()}
        onOpenAgentPicker={jest.fn()}
        onCloseSurface={jest.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-header")).toHaveClass("min-h-[40px]");
    expect(
      screen.queryByRole("button", { name: /test guide/i }),
    ).not.toBeInTheDocument();
  });

  it("contains forward and reverse keyboard focus and restores background interactivity", () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <>
        <button type="button">Global action</button>
        <div>
          <button type="button">Workspace action</button>
          <CanaryTestGuide
            open
            onClose={onClose}
            releaseMetadata={metadata}
            agents={[]}
            loadAgentDetail={loadDetail}
          />
        </div>
      </>,
    );

    const backgroundAction = screen.getByText("Workspace action");
    const globalAction = screen.getByText("Global action");
    const dialog = screen.getByRole("dialog", { name: "Canary test guide" });
    const closeButton = within(dialog).getByRole("button", {
      name: "Close test guide",
    });
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const lastFocusable = focusable.at(-1)!;

    expect(backgroundAction).toHaveAttribute("inert");
    expect(globalAction).toHaveAttribute("inert");
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastFocusable).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    rerender(
      <>
        <button type="button">Global action</button>
        <div>
          <button type="button">Workspace action</button>
          <CanaryTestGuide
            open={false}
            onClose={onClose}
            releaseMetadata={metadata}
            agents={[]}
            loadAgentDetail={loadDetail}
          />
        </div>
      </>,
    );

    expect(backgroundAction).not.toHaveAttribute("inert");
    expect(globalAction).not.toHaveAttribute("inert");
  });
});
