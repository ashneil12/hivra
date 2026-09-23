/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { TaskModal } from "../TaskModal";

describe("TaskModal", () => {
  const agents = [{ id: "inst_1", name: "Atlas", status: "running" }];

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, data: [{ name: "default" }] }),
    }) as jest.Mock;
  });

  it("prefills a beginner-friendly default schedule and onboarding copy for new tasks", async () => {
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        saving={false}
        agents={agents}
        editingJobInitial={null}
        editingAgentId=""
        editingProfileName=""
      />
    );

    expect(screen.getByText(/scheduled tasks let your agent run on its own/i)).toBeInTheDocument();
    // No raw cron field — the default is expressed in plain English via the
    // friendly schedule builder (Daily at 9:00 AM).
    expect(screen.getByRole("button", { name: /^daily$/i })).toBeInTheDocument();
    expect(await screen.findByText(/every day at 9:00 am/i)).toBeInTheDocument();
  });

  it("lets users build a weekly schedule without typing cron, still emitting a raw cron string", async () => {
    const onSave = jest.fn();
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={onSave}
        saving={false}
        agents={agents}
        editingJobInitial={null}
        editingAgentId=""
        editingProfileName=""
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/morning inbox summary/i), { target: { value: "Weekly digest" } });
    fireEvent.change(screen.getByPlaceholderText(/check twitter/i), { target: { value: "Send me the digest" } });

    // Switch to Weekly and apply the Weekdays quick-set — no cron typed.
    fireEvent.click(screen.getByRole("button", { name: /^weekly$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^weekdays$/i }));
    expect(screen.getByText(/every weekdays at 9:00 am/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^save task$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: "0 9 * * 1,2,3,4,5" }),
      false
    );
  });

  it("parses an existing cron back into the builder when editing", async () => {
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        saving={false}
        agents={agents}
        editingJobInitial={{
          id: "job_1",
          name: "Nightly",
          schedule: "30 18 * * *",
          command: "do it",
          enabled: true,
        }}
        editingAgentId="inst_1"
        editingProfileName="default"
      />
    );

    // 30 18 * * * -> daily at 6:30 PM, shown via the readout (no cron field).
    expect(await screen.findByText(/every day at 6:30 pm/i)).toBeInTheDocument();
  });

  it("loads profiles from the instance-scoped API route", async () => {
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        saving={false}
        agents={agents}
        editingJobInitial={null}
        editingAgentId=""
        editingProfileName=""
      />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_1/profiles");
    });
  });

  it("names the agent in plain copy and gives the close control a touch-sized accessible button", () => {
    const onClose = jest.fn();
    render(
      <TaskModal
        isOpen={true}
        onClose={onClose}
        onSave={() => {}}
        saving={false}
        agents={agents}
        agentName="Atlas"
        editingJobInitial={null}
        editingAgentId=""
        editingProfileName=""
      />
    );

    expect(screen.getByRole("heading", { name: "New scheduled task" })).toBeInTheDocument();
    expect(screen.getByText("Tell Atlas what to do and when.")).toBeInTheDocument();
    expect(screen.queryByText(/Hermes/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("enterkeyhint", "next");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveStyle({ width: "44px", height: "44px" });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps all seven weekly day buttons on one row", () => {
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        saving={false}
        agents={agents}
        editingJobInitial={null}
        editingAgentId=""
        editingProfileName=""
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^weekly$/i }));
    const saturday = screen.getByRole("button", { name: "Sat" });
    expect(saturday.parentElement).toHaveStyle({ flexWrap: "nowrap" });
    expect(saturday.parentElement?.children).toHaveLength(7);
    expect(saturday).toHaveStyle({ minWidth: "34px", height: "40px" });
  });

  it("shows Saving… while the task saves and keeps raw cron free of autocapitalization", async () => {
    render(
      <TaskModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        saving={true}
        agents={agents}
        editingJobInitial={{ id: "job_1", name: "Odd", schedule: "*/7 3-5 * * 1", command: "x", enabled: false }}
        editingAgentId="inst_1"
        editingProfileName="default"
      />
    );

    expect(screen.getByRole("heading", { name: "Edit scheduled task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /saving…/i })).toBeDisabled();
    const cron = await screen.findByLabelText("Custom schedule (cron)");
    expect(cron).toHaveAttribute("autocapitalize", "none");
    expect(cron).toHaveAttribute("autocorrect", "off");
    expect(cron).toHaveAttribute("spellcheck", "false");
  });

  describe("keyboard access", () => {
    function Harness({ onClose }: { onClose?: () => void }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>New task</button>
          <TaskModal
            isOpen={open}
            onClose={() => { onClose?.(); setOpen(false); }}
            onSave={() => {}}
            saving={false}
            agents={agents}
            editingJobInitial={null}
            editingAgentId=""
            editingProfileName=""
          />
        </>
      );
    }

    function openModal(onClose?: () => void) {
      render(<Harness onClose={onClose} />);
      const trigger = screen.getByRole("button", { name: "New task" });
      trigger.focus();
      fireEvent.click(trigger);
      return { trigger, dialog: screen.getByRole("dialog", { name: "New scheduled task" }) };
    }

    it("moves focus into the dialog, wraps Tab inside it, and returns focus on Escape", async () => {
      const { trigger, dialog } = openModal();
      const close = within(dialog).getByRole("button", { name: "Close" });
      expect(close).toHaveFocus();

      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(within(dialog).getByRole("button", { name: /^save task$/i })).toHaveFocus();
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
      expect(close).toHaveFocus();

      fireEvent.keyDown(close, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });

    it("lets Escape close an open dropdown menu without closing the dialog", async () => {
      jest.useFakeTimers();
      try {
        const onClose = jest.fn();
        const { dialog } = openModal(onClose);
        fireEvent.click(within(dialog).getByRole("button", { name: "Scheduled" }));
        const paused = await screen.findByRole("button", { name: "Paused" });
        expect(dialog).not.toContainElement(paused);
        act(() => { jest.advanceTimersByTime(100); });

        fireEvent.keyDown(paused, { key: "Escape" });
        expect(screen.queryByRole("button", { name: "Paused" })).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "New scheduled task" })).toBeInTheDocument();
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps a typed draft open on Escape and closes again once it is back to untouched", async () => {
      const onClose = jest.fn();
      const { dialog } = openModal(onClose);
      const name = within(dialog).getByLabelText("Name");
      fireEvent.change(name, { target: { value: "Morning inbox summary" } });
      fireEvent.keyDown(name, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(name).toHaveValue("Morning inbox summary");

      fireEvent.change(name, { target: { value: "" } });
      fireEvent.keyDown(name, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores Escape that ends an IME composition", () => {
      const onClose = jest.fn();
      const { dialog } = openModal(onClose);
      const name = within(dialog).getByLabelText("Name");
      fireEvent.keyDown(name, { key: "Escape", isComposing: true });
      fireEvent.keyDown(name, { key: "Escape", keyCode: 229 });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "New scheduled task" })).toBeInTheDocument();
    });

    it("leaves Escape to a dropdown whose menu has not taken focus yet", async () => {
      const onClose = jest.fn();
      const { dialog } = openModal(onClose);
      const trigger = within(dialog).getByRole("button", { name: "Scheduled" });
      trigger.focus();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(trigger, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Paused" })).not.toBeInTheDocument());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "New scheduled task" })).toBeInTheDocument();
    });

    it("sizes the overlay to the visible viewport so Save stays above the keyboard", () => {
      const { dialog } = openModal();
      expect(dialog.parentElement).toHaveStyle({ top: "0px", height: "var(--workspace-viewport-height, 100dvh)" });
      expect(dialog.parentElement?.style.bottom).toBe("");
    });
  });

  describe("Name field Enter key", () => {
    const editing = { id: "job_1", name: "Nightly", schedule: "30 18 * * *", command: "do it", enabled: true };
    const originalMatchMedia = window.matchMedia;
    afterEach(() => { window.matchMedia = originalMatchMedia; });

    function renderEdit(onSave: jest.Mock) {
      render(
        <TaskModal
          isOpen={true}
          onClose={() => {}}
          onSave={onSave}
          saving={false}
          agents={agents}
          editingJobInitial={editing}
          editingAgentId="inst_1"
          editingProfileName="default"
        />
      );
      return screen.getByLabelText("Name");
    }

    it("moves to the instructions on a touch keyboard's next key instead of saving", () => {
      window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
      const onSave = jest.fn();
      const name = renderEdit(onSave);
      name.focus();
      expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(false);
      expect(screen.getByPlaceholderText(/check twitter/i)).toHaveFocus();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("leaves Enter alone with a fine pointer, so a physical keyboard still submits", () => {
      window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
      const name = renderEdit(jest.fn());
      name.focus();
      expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(true);
      expect(name).toHaveFocus();
    });
  });

  describe("monthly schedule", () => {
    it("stacks the day label like the time label so the dropdowns line up", () => {
      render(
        <TaskModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          saving={false}
          agents={agents}
          editingJobInitial={null}
          editingAgentId=""
          editingProfileName=""
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^monthly$/i }));
      const day = screen.getByRole("group", { name: "Day of month" });
      const time = screen.getByRole("group", { name: "Time" });
      expect(day).toHaveStyle({ display: "grid" });
      expect(time).toHaveStyle({ display: "grid" });
      expect(day.firstElementChild).toHaveTextContent("on day");
      expect(time.firstElementChild).toHaveTextContent("at");
      expect(day.parentElement).toBe(time.parentElement);
      expect(day.parentElement).toHaveStyle({ alignItems: "flex-start" });
    });
  });
});
