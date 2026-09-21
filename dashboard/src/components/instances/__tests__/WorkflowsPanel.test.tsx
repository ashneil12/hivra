/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { WorkflowsPanel } from "@/components/instances/WorkflowsPanel";

describe("WorkflowsPanel", () => {
  beforeEach(() => window.localStorage.clear());

  it("seeds the starter templates and runs one on click", () => {
    const onRunWorkflow = jest.fn(() => true);
    render(<WorkflowsPanel onRunWorkflow={onRunWorkflow} />);

    // Starter templates present.
    expect(screen.getByTestId("workflow-row-weekly-metrics-brief")).toBeInTheDocument();
    expect(screen.getByText("Weekly metrics brief")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workflow-run-weekly-metrics-brief"));
    expect(onRunWorkflow).toHaveBeenCalledWith(expect.stringContaining("weekly metrics brief"));
  });

  it("keeps the sample result hidden until the Sample toggle is pressed", () => {
    render(<WorkflowsPanel onRunWorkflow={() => true} />);

    // No always-on sample result.
    expect(screen.queryByText(/Revenue: \$42,100/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workflow-sample-weekly-metrics-brief"));
    expect(screen.getByText(/Revenue: \$42,100/)).toBeInTheDocument();
  });

  it("hides a workflow (archives, not deletes) and persists the hidden state", () => {
    const { unmount } = render(<WorkflowsPanel onRunWorkflow={() => true} />);
    fireEvent.click(screen.getByTestId("workflow-hide-inbox-triage"));

    // Gone from the visible list...
    expect(screen.queryByTestId("workflow-row-inbox-triage")).not.toBeInTheDocument();
    // ...but preserved in the Hidden drawer, not destroyed.
    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));
    expect(screen.getByTestId("workflow-hidden-row-inbox-triage")).toBeInTheDocument();

    // Persisted: a fresh mount keeps it hidden (not resurrected to the list, not lost).
    unmount();
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    expect(screen.queryByTestId("workflow-row-inbox-triage")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));
    expect(screen.getByTestId("workflow-hidden-row-inbox-triage")).toBeInTheDocument();
  });

  it("restores a hidden workflow back to the visible list", () => {
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    fireEvent.click(screen.getByTestId("workflow-hide-competitor-teardown"));
    expect(screen.queryByTestId("workflow-row-competitor-teardown")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));
    fireEvent.click(screen.getByTestId("workflow-restore-competitor-teardown"));

    // Back on the list, and the (now-empty) Hidden drawer toggle is gone.
    expect(screen.getByTestId("workflow-row-competitor-teardown")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-hidden-toggle")).not.toBeInTheDocument();
  });

  it("permanently deletes a workflow only after an explicit confirm", () => {
    const { unmount } = render(<WorkflowsPanel onRunWorkflow={() => true} />);
    fireEvent.click(screen.getByTestId("workflow-hide-inbox-triage"));
    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));

    // First tap only ARMS the confirm — the workflow is still there.
    fireEvent.click(screen.getByTestId("workflow-delete-inbox-triage"));
    expect(screen.getByTestId("workflow-hidden-row-inbox-triage")).toBeInTheDocument();

    // Confirm actually removes it.
    fireEvent.click(screen.getByTestId("workflow-delete-confirm-inbox-triage"));
    expect(screen.queryByTestId("workflow-row-inbox-triage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-hidden-toggle")).not.toBeInTheDocument();

    // Fully gone across a remount.
    unmount();
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    expect(screen.queryByTestId("workflow-row-inbox-triage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-hidden-toggle")).not.toBeInTheDocument();
  });

  it("cancels a pending delete without removing the workflow", () => {
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    fireEvent.click(screen.getByTestId("workflow-hide-inbox-triage"));
    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));
    fireEvent.click(screen.getByTestId("workflow-delete-inbox-triage"));
    fireEvent.click(screen.getByTestId("workflow-delete-cancel-inbox-triage"));

    // Still archived and restorable — nothing lost.
    expect(screen.getByTestId("workflow-hidden-row-inbox-triage")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-restore-inbox-triage")).toBeInTheDocument();
  });

  it("does not auto-reopen the Hidden drawer after it empties and refills", () => {
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    // Open the drawer, then restore the only hidden item (drawer empties while open).
    fireEvent.click(screen.getByTestId("workflow-hide-inbox-triage"));
    fireEvent.click(screen.getByTestId("workflow-hidden-toggle"));
    fireEvent.click(screen.getByTestId("workflow-restore-inbox-triage"));
    // Hide a different one — the toggle returns, but collapsed (no stale open state).
    fireEvent.click(screen.getByTestId("workflow-hide-competitor-teardown"));
    expect(screen.getByTestId("workflow-hidden-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("workflow-hidden-row-competitor-teardown")).not.toBeInTheDocument();
  });

  it("auto-expands the Hidden drawer when the list mounts fully hidden", () => {
    window.localStorage.setItem(
      "hivra_workflows",
      JSON.stringify([
        { id: "weekly-metrics-brief", title: "Weekly metrics brief", prompt: "x", hidden: true },
        { id: "competitor-teardown", title: "Competitor teardown", prompt: "x", hidden: true },
      ]),
    );
    render(<WorkflowsPanel onRunWorkflow={() => true} />);

    expect(screen.getByText(/every workflow is hidden/i)).toBeInTheDocument();
    // Restore controls are visible immediately — no extra click needed.
    expect(screen.getByTestId("workflow-hidden-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("workflow-restore-weekly-metrics-brief")).toBeInTheDocument();
  });

  it("creates a custom workflow, runs it, and persists it", () => {
    const onRunWorkflow = jest.fn(() => true);
    const { unmount } = render(<WorkflowsPanel onRunWorkflow={onRunWorkflow} />);

    fireEvent.click(screen.getByTestId("workflow-create-open"));
    fireEvent.change(screen.getByTestId("workflow-create-title"), { target: { value: "Daily sales recap" } });
    fireEvent.change(screen.getByTestId("workflow-create-prompt"), {
      target: { value: "Summarize today's sales and flag anything unusual." },
    });
    fireEvent.click(screen.getByTestId("workflow-create-save"));

    expect(screen.getByText("Daily sales recap")).toBeInTheDocument();

    // Persisted across a remount.
    unmount();
    render(<WorkflowsPanel onRunWorkflow={onRunWorkflow} />);
    expect(screen.getByText("Daily sales recap")).toBeInTheDocument();
  });

  it("shows an all-hidden empty state (not a destructive one) when every workflow is hidden", () => {
    render(<WorkflowsPanel onRunWorkflow={() => true} />);
    for (const id of ["weekly-metrics-brief", "competitor-teardown", "content-repurposing", "inbox-triage"]) {
      fireEvent.click(screen.getByTestId(`workflow-hide-${id}`));
    }
    // The list is empty but the workflows aren't gone — they're all recoverable.
    expect(screen.getByText(/every workflow is hidden/i)).toBeInTheDocument();
    expect(screen.getByTestId("workflow-hidden-toggle")).toHaveTextContent(/hidden \(4\)/i);
  });
});
