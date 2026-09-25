// Activity rows for an agent added to a computer (design 5.7).
import { attachActivityLine } from "../attach-activity";

it("words each attach event as the design has it", () => {
  const fields = { agentName: "Codex", computerName: "MY_UBUNTU_DESKTOP", access: "~/Hivra read and write, internet" };
  expect(attachActivityLine("agent_attached", fields)).toBe("Codex added to MY_UBUNTU_DESKTOP · access: ~/Hivra read and write, internet");
  expect(attachActivityLine("agent_access_changed", fields)).toBe("Access changed");
  expect(attachActivityLine("agent_removed", fields)).toBe("Codex removed · files in ~/Hivra kept");
  expect(attachActivityLine("agent_attach_failed", fields)).toBe("Codex not added to MY_UBUNTU_DESKTOP");
  expect(attachActivityLine("restarted", fields)).toBeNull();
});

it("never shows a field it does not recognise", () => {
  expect(attachActivityLine("agent_attached", { agentName: "<script>", computerName: "A\nB", access: "everything" })).toBe("Agent added");
  expect(attachActivityLine("agent_attached", { computerName: "x".repeat(65) })).toBe("Agent added");
  expect(attachActivityLine("agent_removed", null)).toBe("Agent removed · files in ~/Hivra kept");
});
