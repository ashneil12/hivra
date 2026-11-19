/** @jest-environment node */

import { NextRequest } from "next/server";

const claimMock = jest.fn();

let mockOperator = true;
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "user_123" }), currentUser: async () => null }));
jest.mock("@/lib/ops-access", () => ({ isOpsAdminUser: () => mockOperator, verifiedPrimaryEmailOf: () => null }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  claimPreparedCanaryComputer: (...args: unknown[]) => claimMock(...args),
}));
jest.mock("@/lib/hivra/agent-llm", () => ({ sanitizeHivraAgentRow: (value: unknown) => value }));

import { POST } from "../route";

function request(body: unknown) {
  return new NextRequest("https://canary.example.test/api/hivra/prepared-computers", {
    method: "POST",
    headers: {
      host: "canary.example.test",
      origin: "https://canary.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

it("rejects new Windows prepared-computer claims before lifecycle code", async () => {
  const response = await POST(request({ profile: "windows", name: "WINDOWS" }));
  expect(response.status).toBe(400);
  expect(claimMock).not.toHaveBeenCalled();
});

it("retains the Omarchy prepared-computer claim route", async () => {
  claimMock.mockResolvedValue({ id: "agent_123", name: "OMARCHY", status: "running" });
  const response = await POST(request({ profile: "omarchy", name: "OMARCHY" }));
  expect(response.status).toBe(201);
  expect(claimMock).toHaveBeenCalledWith({ userId: "user_123", profile: "omarchy", name: "OMARCHY", operator: true });
});

it("never echoes an internal claim error message to the client", async () => {
  claimMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8006 proxmox_host=internal-node-7"));
  const response = await POST(request({ profile: "omarchy", name: "OMARCHY" }));
  const text = await response.text();
  expect(response.status).toBe(503);
  expect(text).toContain("prepared_guest_unavailable");
  expect(text).not.toContain("ECONNREFUSED");
  expect(text).not.toContain("internal-node-7");
});

it("passes a non-operator account through as such and reports the operator-only refusal", async () => {
  mockOperator = false;
  claimMock.mockReset().mockRejectedValue(new Error("prepared_computer_operator_only"));
  const response = await POST(request({ profile: "omarchy", name: "OMARCHY" }));
  expect(response.status).toBe(403);
  expect(claimMock).toHaveBeenCalledWith(expect.objectContaining({ operator: false }));
  mockOperator = true;
});
