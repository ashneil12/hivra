/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import ResourcesTab from "../ResourcesTab";

function response(payload: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => payload };
}

const initialUsage = {
  success: true,
  data: {
    subscribed: true,
    plan: { name: "Power", maxAgents: 5, totalCpu: 4, totalRam: 8192 },
    usage: {
      agentCount: 2,
      maxAgents: 5,
      usedCpu: 3,
      usedRam: 6144,
      totalCpu: 4,
      totalRam: 8192,
      instances: [
        { source: "hermes", id: "pike", name: "Pike", status: "running", cpu: 2, ram: 4096 },
        { source: "hivra", id: "codex", name: "Codex", status: "running", cpu: 1, ram: 2048 },
      ],
    },
  },
};

const resizedUsage = {
  success: true,
  data: {
    ...initialUsage.data,
    usage: {
      ...initialUsage.data.usage,
      usedCpu: 2,
      usedRam: 4096,
      instances: [
        { source: "hermes", id: "pike", name: "Pike", status: "running", cpu: 1, ram: 2048 },
        { source: "hivra", id: "codex", name: "Codex", status: "running", cpu: 1, ram: 2048 },
      ],
    },
  },
};

describe("ResourcesTab", () => {
  beforeEach(() => jest.clearAllMocks());

  it("loads the authoritative pool and shows every active allocation", async () => {
    global.fetch = jest.fn().mockResolvedValue(response(initialUsage)) as unknown as typeof fetch;

    render(<ResourcesTab instanceId="pike" />);

    expect(await screen.findByText("1 vCPU free")).toBeInTheDocument();
    expect(screen.getByText("2 GB RAM free")).toBeInTheDocument();
    expect(screen.getByText("Pike")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 agent slots used")).toBeInTheDocument();
  });

  it("sends RAM in megabytes, confirms the restart, and refreshes the pool", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(initialUsage))
      .mockResolvedValueOnce(response({ success: true, data: { cpuLimit: 1, ramLimit: 2048 } }))
      .mockResolvedValueOnce(response(resizedUsage));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ResourcesTab instanceId="pike" />);

    await screen.findByText("1 vCPU free");
    fireEvent.click(screen.getByRole("button", { name: "1 vCPU" }));
    fireEvent.click(screen.getByRole("button", { name: "2 GB" }));
    fireEvent.click(screen.getByRole("button", { name: /review resize/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm resize/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/instances/pike/resource-reallocation",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cpuLimit: 1, ramLimit: 2048 }),
      }),
    );
    expect(await screen.findByText(/Pike now uses 1 vCPU and 2 GB RAM/i)).toBeInTheDocument();
    expect(screen.getByText("2 vCPU free")).toBeInTheDocument();
    expect(screen.getByText("4 GB RAM free")).toBeInTheDocument();
  });

  it("does not advertise a successful resize when the host action fails", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(initialUsage))
      .mockResolvedValueOnce(response({ success: false, error: "Pike could not be resized; no allocation was changed." }, false));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ResourcesTab instanceId="pike" />);
    await screen.findByText("1 vCPU free");
    fireEvent.click(screen.getByRole("button", { name: "1 vCPU" }));
    fireEvent.click(screen.getByRole("button", { name: /review resize/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm resize/i }));

    expect(await screen.findByText(/no allocation was changed/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a retry state when the pool cannot be loaded", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ success: false, error: "usage unavailable" }, false)) as unknown as typeof fetch;

    render(<ResourcesTab instanceId="pike" />);

    expect(await screen.findByText(/usage unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
