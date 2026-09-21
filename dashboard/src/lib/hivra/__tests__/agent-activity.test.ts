import { agentActivityPresentation } from "@/lib/hivra/agent-activity";

const freshLaunch = {
  activity: "provision" as const,
  provisioned_at: null,
  cpu: 2,
  ram: 4,
};

describe("agentActivityPresentation", () => {
  it("describes a fresh Ubuntu computer without inventing an attached agent", () => {
    const presentation = agentActivityPresentation({
      ...freshLaunch,
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
    }, "Ubuntu Desktop");

    expect(presentation.body).toContain("open its desktop, terminal, and files");
    expect(presentation.body).toContain("No agent is attached");
    expect(presentation.body).not.toContain("open the agent");
    expect(presentation.body).not.toContain("takes a few minutes");
    expect(presentation.body).toContain("leave this page and return later");
  });

  it("keeps agent-specific setup guidance for a fresh Codex launch", () => {
    const presentation = agentActivityPresentation({
      ...freshLaunch,
      type: "codex",
      computer_profile: null,
    }, "Codex");

    expect(presentation.body).toContain("open the agent");
    expect(presentation.body).toContain("connect any accounts it needs");
  });
});
