/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

    fireEvent.change(screen.getByPlaceholderText(/target purge/i), { target: { value: "Weekly digest" } });
    fireEvent.change(screen.getByPlaceholderText(/check twitter/i), { target: { value: "Send me the digest" } });

    // Switch to Weekly and apply the Weekdays quick-set — no cron typed.
    fireEvent.click(screen.getByRole("button", { name: /^weekly$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^weekdays$/i }));
    expect(screen.getByText(/every weekdays at 9:00 am/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /commit tasks/i }));
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
});
