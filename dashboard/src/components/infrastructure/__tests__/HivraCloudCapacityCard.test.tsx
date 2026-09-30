/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

import { HivraCloudCapacityCard, managedComputerKind } from "../HivraCloudCapacityCard";
import type { HivraCloudCapacityDto } from "@/lib/infrastructure/hivra-cloud-client";

function computer(id: string, name: string, type: string | null, source: "hermes" | "hivra" = "hivra") {
  return { source, id, name, type, status: "running", cpu: 2, ram: 4096, disk_size_gb: 0, disk_upgraded: false, backups_enabled: false };
}

const capacity = {
  subscribed: true,
  paid: true,
  plan: { key: "command", name: "Command", price: 0, maxAgents: 999, maxCpuPerAgent: 8, maxRamPerAgent: 16384,
    totalCpu: 24, totalRam: 131072, status: "active", currentPeriodEnd: null, source: "stripe", canChangePlanInPlace: true },
  usage: { agentCount: 5, maxAgents: 999, usedCpu: 10, totalCpu: 24, usedRam: 20480, totalRam: 131072, instances: [
    computer("a", "MY_WINDOWS_DESKTOP", "linux-desktop"),
    computer("b", "CODEX_AGENT", "codex"),
    computer("c", "CANARY_CHANNEL_A0", "agent-zero"),
    computer("d", "Old Hermes", null, "hermes"),
    computer("e", "Unknown kind", "something-new"),
  ] },
} as HivraCloudCapacityDto;

it("names each managed computer in product words, never its type id", () => {
  render(<HivraCloudCapacityCard capacity={capacity} onUpgrade={jest.fn()} />);
  const row = (name: string) => screen.getByText(name).closest("span") as HTMLElement;
  expect(within(row("MY_WINDOWS_DESKTOP")).getByText("Desktop computer")).toBeInTheDocument();
  expect(within(row("CODEX_AGENT")).getByText("Codex")).toBeInTheDocument();
  expect(within(row("CANARY_CHANNEL_A0")).getByText("Agent Zero")).toBeInTheDocument();
  expect(within(row("Old Hermes")).getByText("Hermes")).toBeInTheDocument();
  expect(within(row("Unknown kind")).getByText("Agent")).toBeInTheDocument();
  for (const id of ["linux-desktop", "codex", "agent-zero", "something-new"]) {
    expect(screen.queryByText(id)).not.toBeInTheDocument();
  }
});

it("keeps Linux Sandbox and missing types readable", () => {
  expect(managedComputerKind({ source: "hivra", type: "linux-terminal" })).toBe("Linux Sandbox");
  expect(managedComputerKind({ source: "hivra", type: null })).toBe("Agent");
  expect(managedComputerKind({ source: "hivra" })).toBe("Agent");
});
