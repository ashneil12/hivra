jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { aggregateHivraActivity } from "../hivra-activity";

it("gives an attach event its own words and nothing else from its detail (design 5.7)", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const activity = aggregateHivraActivity([
    { id: "e1", agent_id: "a1", event: "agent_attached", agent_type: "linux-desktop", created_at: "2026-09-24T11:00:00Z",
      attach_agent: "Codex", attach_computer: "MY_UBUNTU_DESKTOP", attach_access: "internet, no shared folder" },
    { id: "e2", agent_id: "a1", event: "restarted", agent_type: "linux-desktop", created_at: "2026-09-24T10:00:00Z",
      attach_computer: "MY_UBUNTU_DESKTOP" },
  ], [], [], ["2026-09-24"], now);
  expect(activity.recent[0]).toEqual({ id: "e1", event: "agent_attached", agentType: "linux-desktop", agentId: "a1",
    createdAt: "2026-09-24T11:00:00Z", summary: "Codex added to MY_UBUNTU_DESKTOP · access: internet, no shared folder" });
  expect(activity.recent[1]).not.toHaveProperty("summary");
});
