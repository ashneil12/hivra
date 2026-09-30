/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import ChatIndexPage from "../page";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolveDefaultHivraResource } from "@/lib/workspace/default-resource";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

// Next's redirect() throws to end rendering; mirror that so code after it never runs.
jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: () => undefined })),
}));

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn() } }));

jest.mock("@/lib/workspace/default-resource", () => ({
  resolveDefaultHivraResource: jest.fn(),
}));

let mockHermesRow: { id: string; backend: string | null } | null = null;
jest.mock("@/lib/supabase", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: mockHermesRow }),
  };
  return { supabaseAdmin: { from: () => builder } };
});

const props = { searchParams: Promise.resolve({}) };

describe("ChatIndexPage", () => {
  const mockedAuth = auth as unknown as jest.Mock;
  const mockedRedirect = redirect as unknown as jest.Mock;
  const mockedResolveHivra = resolveDefaultHivraResource as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHermesRow = null;
    mockedAuth.mockResolvedValue({ userId: "user_1" });
    mockedResolveHivra.mockResolvedValue(null);
  });

  it("sends an owner with only Hivra agents to that agent's chat", async () => {
    mockedResolveHivra.mockResolvedValue("agent 7");

    await expect(ChatIndexPage(props)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockedResolveHivra).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1" }));
    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard/agent/agent%207?tab=chat");
  });

  it("still prefers an existing Hermes instance", async () => {
    mockHermesRow = { id: "inst_1", backend: null };
    mockedResolveHivra.mockResolvedValue("agent-7");

    await expect(ChatIndexPage(props)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect.mock.calls[0][0]).toMatch(/^\/dashboard\/instances\/inst_1/);
    expect(mockedResolveHivra).not.toHaveBeenCalled();
  });

  it("offers Launch and Home, with no retry loop, when the account has no agents", async () => {
    render(await ChatIndexPage(props));

    expect(screen.getByRole("heading", { name: "Chat needs an agent first." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch");
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/dashboard");
    expect(screen.queryByRole("link", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/hermes instance|command center/i)).not.toBeInTheDocument();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });

  it("falls back to the empty state when the Hivra lookup throws", async () => {
    mockedResolveHivra.mockRejectedValue(new Error("network down"));

    render(await ChatIndexPage(props));

    expect(screen.getByRole("link", { name: "Launch an agent" })).toBeInTheDocument();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });
});
