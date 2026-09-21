/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import type {
  WorkspaceSurface,
  WorkspaceSurfaceDescriptor,
} from "@/lib/workspace/workspace-contracts";
import { serializeWorkspaceRoute } from "@/lib/workspace/workspace-route-state";

import { SurfaceControls } from "../SurfaceControls";
import { SurfacePanel } from "../SurfacePanel";

const available = (
  surface: WorkspaceSurface,
  label: string,
): WorkspaceSurfaceDescriptor => ({
  surface,
  label,
  availability: "available",
});

const ALL_DESCRIPTORS: readonly WorkspaceSurfaceDescriptor[] = [
  available("desktop", "Desktop"),
  available("browser", "Browser"),
  available("terminal", "Terminal"),
  available("git", "Git"),
  available("files", "Files"),
  available("native", "Hermes"),
  available("workspace", "Aeon"),
  available("conversation", "Conversation"),
];

describe("SurfaceControls", () => {
  it("renders only strict descriptors in the approved labeled order", () => {
    const malformed = {
      surface: "future-admin",
      label: "Admin",
      availability: "available",
    } as unknown as WorkspaceSurfaceDescriptor;

    render(
      <SurfaceControls
        descriptors={[...ALL_DESCRIPTORS, malformed]}
        selectedSurface="conversation"
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Conversation",
      // Desktop leads the non-chat surfaces: for the resources that have one it
      // IS the resource. A computer's tabs used to read
      // "Files · Git · Terminal · Desktop", burying its primary surface.
      "Desktop",
      "Aeon",
      "Hermes",
      "Files",
      "Git",
      "Terminal",
      "Browser",
    ]);
    expect(screen.queryByRole("tab", { name: "Admin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Native runtime" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Agent surfaces" })).toHaveClass(
      "px-3.5",
    );
  });

  it.each([
    ["unavailable" as const, "Terminal is reconnecting."],
    ["unknown" as const, "Terminal state has not been observed."],
  ])(
    "keeps a supported %s surface focusable but non-usable with its reason",
    (availability, reason) => {
      const onSelect = jest.fn();
      render(
        <SurfaceControls
          descriptors={[
            available("conversation", "Conversation"),
            { surface: "terminal", label: "Terminal", availability, reason },
          ]}
          selectedSurface="conversation"
          onSelect={onSelect}
        />,
      );

      const terminal = screen.getByRole("tab", { name: "Terminal" });
      expect(terminal).toHaveAttribute("aria-disabled", "true");
      fireEvent.focus(terminal);
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      fireEvent.click(terminal);
      fireEvent.keyDown(terminal, { key: "Enter" });
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("supports roving Arrow Left/Right, Home/End, Enter, and Space keys", () => {
    const onSelect = jest.fn();
    render(
      <SurfaceControls
        descriptors={[
          available("desktop", "Desktop"),
          available("conversation", "Conversation"),
          available("browser", "Browser"),
        ]}
        selectedSurface="conversation"
        onSelect={onSelect}
      />,
    );

    const conversation = screen.getByRole("tab", { name: "Conversation" });
    const browser = screen.getByRole("tab", { name: "Browser" });
    const desktop = screen.getByRole("tab", { name: "Desktop" });

    // Render order is conversation, desktop, browser (desktop leads), so the
    // roving cycle is Conversation → Desktop → Browser → Conversation.
    conversation.focus();
    fireEvent.keyDown(conversation, { key: "ArrowRight" });
    expect(desktop).toHaveFocus();
    fireEvent.keyDown(desktop, { key: "End" });
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "ArrowRight" });
    expect(conversation).toHaveFocus();
    fireEvent.keyDown(conversation, { key: "ArrowLeft" });
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "Home" });
    expect(conversation).toHaveFocus();

    fireEvent.keyDown(browser, { key: "Enter" });
    fireEvent.keyDown(desktop, { key: " " });
    expect(onSelect.mock.calls.map(([surface]) => surface)).toEqual([
      "browser",
      "desktop",
    ]);
  });
});

function NavigationHarness() {
  const agentUid = "x-selected-agent";
  const [surface, setSurface] = useState<WorkspaceSurface>("conversation");
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  function navigate(nextSurface: WorkspaceSurface) {
    setSurface(nextSurface);
    window.history.pushState(
      {},
      "",
      serializeWorkspaceRoute({ agent: agentUid, surface: nextSurface }),
    );
  }

  return (
    <div className="relative">
      <SurfaceControls
        descriptors={[
          available("conversation", "Conversation"),
          available("terminal", "Terminal"),
        ]}
        selectedSurface={surface}
        onSelect={(nextSurface, nextTrigger) => {
          setTrigger(nextTrigger);
          navigate(nextSurface);
        }}
      />
      {surface === "terminal" ? (
        <SurfacePanel
          agentUid={agentUid}
          agentName="Selected agent"
          surface="terminal"
          surfaceLabel="Terminal"
          onClose={() => {
            navigate("conversation");
            window.setTimeout(() => trigger?.focus(), 0);
          }}
        >
          <p>Real terminal content</p>
        </SurfacePanel>
      ) : (
        <p>Conversation content</p>
      )}
    </div>
  );
}

describe("SurfacePanel navigation", () => {
  beforeEach(() => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/workspace?agent=x-selected-agent&surface=conversation",
    );
  });

  it("replaces the conversation with the selected surface and restores it on close", async () => {
    render(<NavigationHarness />);

    expect(screen.getByText("Conversation content")).toBeInTheDocument();

    const terminalTrigger = screen.getByRole("tab", { name: "Terminal" });
    fireEvent.click(terminalTrigger);

    const panel = screen.getByRole("region", {
      name: "Terminal surface for Selected agent",
    });
    expect(panel).toHaveAttribute("data-agent-uid", "x-selected-agent");
    expect(panel).toHaveAttribute("data-surface", "terminal");
    expect(window.location.search).toBe(
      "?agent=x-selected-agent&surface=terminal",
    );
    expect(screen.getByText("Real terminal content")).toBeInTheDocument();
    // The whole point of the change: the terminal takes the content area, it
    // does not open a second column beside the conversation it replaced.
    expect(screen.queryByText("Conversation content")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(window.location.search).toBe(
      "?agent=x-selected-agent&surface=conversation",
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByText("Conversation content")).toBeInTheDocument();
    await waitFor(() => expect(terminalTrigger).toHaveFocus());
  });

  it("fills the content area rather than splitting it with the conversation", () => {
    render(<NavigationHarness />);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    const panel = screen.getByTestId("surface-panel");
    // A flex-1 column in the content area, not a fixed-width right-hand pane.
    expect(panel.className).toContain("flex-1");
    expect(panel.className).toContain("h-full");
    expect(panel.className).not.toContain("clamp(440px,42vw,720px)");
    expect(panel.className).not.toContain("fixed");
    expect(panel.className).not.toContain("inset-0");
  });

  it("renders no duplicate surface chrome inside the panel", () => {
    render(<NavigationHarness />);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    // The tab strip already names the surface. A "Back to conversation" button
    // and a second display-serif title inside the pane duplicated it, so
    // opening Terminal showed the word "Terminal" twice.
    expect(
      screen.queryByRole("button", { name: "Back to conversation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeInTheDocument();
  });
});
