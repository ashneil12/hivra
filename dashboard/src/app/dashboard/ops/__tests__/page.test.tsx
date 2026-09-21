/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import OpsPage from "../page";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { isOpsAdminUser } from "@/lib/ops-access";

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );

  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();

  return {
    auth: authMock,
    currentUser: jest.fn(),
  };
});

jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}));

jest.mock("@/components/InteractiveBackground", () => () => null);

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-page-shell">{children}</div>
  ),
}));

jest.mock("@/components/ops/OpsArchiveButton", () => ({
  OpsArchiveButton: () => <button type="button">Archive All</button>,
}));

jest.mock("@/components/ops/OpsDeleteAllButton", () => ({
  OpsDeleteAllButton: () => <button type="button">Delete All</button>,
}));

jest.mock("@/components/ops/OpsCopyAllButton", () => ({
  OpsCopyAllButton: () => <button type="button">Copy All</button>,
}));

jest.mock("@/components/ops/OpsHandoffCopyButton", () => ({
  OpsHandoffCopyButton: () => <button type="button">Copy Handoff</button>,
}));

jest.mock("@/components/ops/OpsRowActions", () => ({
  OpsRowActions: () => (
    <div>
      <button type="button">Archive</button>
      <button type="button">Delete</button>
    </div>
  ),
}));

jest.mock("@/components/ops/OpsSourceGroup", () => ({
  OpsSourceGroup: ({ source, children }: { source: string; children: React.ReactNode }) => (
    <section>
      <h2>{source}</h2>
      <div>{children}</div>
    </section>
  ),
}));

jest.mock("@/lib/ops-event-classification", () => ({
  classifyOpsEvent: jest.fn(() => "other"),
}));

jest.mock("@/lib/ops-event-handoff", () => ({
  buildOpsEventHandoffPrompt: jest.fn(() => "Investigate this incident"),
}));

jest.mock("@/lib/ops-event-hosts", () => ({
  extractOpsEventHostIp: jest.fn(() => "203.0.113.10"),
  resolveOpsEventHostIpMap: jest.fn(async () => new Map([["inst_123", "203.0.113.10"]])),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/ops-access", () => ({
  isOpsAdminUser: jest.fn(),
}));

describe("OpsPage", () => {
  const mockedAuth = auth as unknown as jest.Mock & { protect: jest.Mock };
  const mockedCurrentUser = currentUser as jest.Mock;
  const mockedRedirect = redirect as unknown as jest.Mock;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedIsOpsAdminUser = isOpsAdminUser as jest.Mock;

  let mockQuery: Record<string, jest.Mock | ((resolve: (value: unknown) => void) => void)>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockedAuth.mockResolvedValue({ userId: "user_123" });
    mockedAuth.protect.mockResolvedValue(undefined);
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "admin@example.com" },
    });
    mockedRedirect.mockImplementation(() => undefined);

    mockQuery = {
      select: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
        resolve({
          data: [
            {
              id: "evt_123",
              source: "client-runtime",
              severity: "error",
              title: "Unhandled client exception",
              message: "Exploded",
              route: "/dashboard/chat",
              user_id: "user_123",
              instance_id: "inst_123",
              conversation_id: null,
              profile_name: null,
              metadata: {
                failureOwner: "hypervisor",
                failurePhase: "delete",
                failureType: "proxmox_destroy_failed",
                recoveryAction: "contact_support",
                requestId: "req_123",
              },
              sample_stack: null,
              first_seen_at: "2026-04-19T10:00:00.000Z",
              last_seen_at: "2026-04-19T10:05:00.000Z",
              occurrence_count: 2,
            },
          ],
          error: null,
        }),
    };

    mockedFrom.mockReturnValue(mockQuery);
  });

  it("redirects non-admin users away from the incidents page", async () => {
    mockedIsOpsAdminUser.mockReturnValue(false);

    const ui = await OpsPage({
      searchParams: Promise.resolve({}),
    });

    expect(ui).toBeNull();
    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("preserves the global feed controls for ops admins", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);

    const ui = await OpsPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    expect(mockQuery.eq).not.toHaveBeenCalledWith("user_id", "user_123");
    expect(screen.getByRole("button", { name: /copy all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive all/i })).toBeInTheDocument();
    expect(screen.getByText(/internal ops feed/i)).toBeInTheDocument();
    expect(screen.getByText(/server ip:/i)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    expect(screen.getByText(/owner:/i)).toBeInTheDocument();
    expect(screen.getByText(/Infrastructure issue/)).toBeInTheDocument();
    expect(screen.getByText(/phase:/i)).toBeInTheDocument();
    expect(screen.getByText(/Deletion/)).toBeInTheDocument();
    expect(screen.getByText(/recovery:/i)).toBeInTheDocument();
    expect(screen.getByText(/Contact support/)).toBeInTheDocument();
    expect(screen.getByText(/request:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/req_123/).length).toBeGreaterThan(0);
  });

  it("keeps synthetic observability failures visible in the internal ops feed", async () => {
    mockedIsOpsAdminUser.mockReturnValue(true);
    mockQuery.then = (resolve: (value: { data: unknown[]; error: null }) => void) =>
      resolve({
        data: [
          {
            id: "evt_synthetic_123",
            source: "synthetic.instance-health",
            severity: "error",
            title: "Synthetic instance health probe failed",
            message: "The operator health probe could not reach the instance gateway.",
            route: null,
            user_id: null,
            instance_id: "inst_123",
            conversation_id: null,
            profile_name: null,
            metadata: {
              failureOwner: "runtime",
              failurePhase: "runtime",
              failureType: "instance_health_probe_failed",
              recoveryAction: "repair_runtime",
              requestId: "req_synthetic_123",
            },
            sample_stack: null,
            first_seen_at: "2026-05-05T10:00:00.000Z",
            last_seen_at: "2026-05-05T10:05:00.000Z",
            occurrence_count: 1,
          },
        ],
        error: null,
      });

    const ui = await OpsPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    expect(screen.getByText("Synthetic instance health probe failed")).toBeInTheDocument();
    expect(screen.getByText(/runtime issue/i)).toBeInTheDocument();
    expect(screen.getByText(/phase:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Runtime/).length).toBeGreaterThan(0);
    expect(screen.getByText(/recovery:/i)).toBeInTheDocument();
    expect(screen.getByText(/Repair runtime/)).toBeInTheDocument();
    expect(screen.getAllByText(/req_synthetic_123/).length).toBeGreaterThan(0);
  });
});
