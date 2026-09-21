/** @jest-environment node */

import { NextRequest } from "next/server";

const claimMock = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "user_123" }) }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
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
  expect(claimMock).toHaveBeenCalledWith({ userId: "user_123", profile: "omarchy", name: "OMARCHY" });
});
