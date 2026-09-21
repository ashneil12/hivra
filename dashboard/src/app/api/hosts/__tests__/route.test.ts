import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn(),
}));

describe("GET /api/hosts", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedGetHetznerInstanceStatus =
    getHetznerInstanceStatus as jest.MockedFunction<typeof getHetznerInstanceStatus>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("hides unexpected host listing errors from the client", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("hosts-secret-leak"));

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("hosts-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("hosts-secret-leak");
  });

  it("does not log raw database errors when fetching hosts fails", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: null,
        error: { message: "hosts-db-secret" },
      }),
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to fetch hosts");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("hosts-db-secret");
  });

  it("syncs stopped hosts back to the live Hetzner status", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHetznerInstanceStatus.mockResolvedValue({
      status: "running",
      ipv4: "203.0.113.10",
    });

    const hostUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
    const hostUpdateMock = jest.fn().mockReturnValue({
      eq: hostUpdateEqMock,
    });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({
            data: [
              {
                id: "host-1",
                user_id: "user-123",
                hetzner_server_id: 42,
                status: "stopped",
                created_at: "2026-04-23T10:00:00.000Z",
              },
            ],
            error: null,
          }),
          update: hostUpdateMock,
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0].status).toBe("running");
    expect(hostUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        updated_at: expect.any(String),
      })
    );
    expect(hostUpdateEqMock).toHaveBeenCalledWith("id", "host-1");
  });

  it("renders the rest of the list when one host's status fetch fails", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);

    // Host 1 is unreachable (status fetch rejects); host 2 is healthy.
    mockedGetHetznerInstanceStatus.mockImplementation(async (serverId: number) => {
      if (serverId === 1) {
        throw new Error("hetzner-unreachable");
      }
      return { status: "running", ipv4: "203.0.113.20" };
    });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({
            data: [
              {
                id: "host-1",
                user_id: "user-123",
                hetzner_server_id: 1,
                status: "running",
                created_at: "2026-04-23T10:00:00.000Z",
              },
              {
                id: "host-2",
                user_id: "user-123",
                hetzner_server_id: 2,
                status: "stopped",
                created_at: "2026-04-23T11:00:00.000Z",
              },
            ],
            error: null,
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const json = await response.json();

    // The whole page must NOT 500 because of one unreachable host.
    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(2);
    // Failing host keeps its last-known status; healthy host syncs to live status.
    expect(json.data[0].id).toBe("host-1");
    expect(json.data[0].status).toBe("running");
    expect(json.data[1].id).toBe("host-2");
    expect(json.data[1].status).toBe("running");
  });

  it("keeps the list rendering when a host's status write fails", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHetznerInstanceStatus.mockResolvedValue({
      status: "running",
      ipv4: "203.0.113.10",
    });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({
            data: [
              {
                id: "host-1",
                user_id: "user-123",
                hetzner_server_id: 42,
                status: "stopped",
                created_at: "2026-04-23T10:00:00.000Z",
              },
            ],
            error: null,
          }),
          // The status write rejects (e.g. transient DB error) — must not 500 the page.
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockRejectedValue(new Error("host-write-failed")),
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(1);
    // Write failed, so the row keeps its last-known status rather than crashing.
    expect(json.data[0].status).toBe("stopped");
  });

  it("normalizes Hetzner rebuilding into provisioning for host rows", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHetznerInstanceStatus.mockResolvedValue({
      status: "redeploying",
      ipv4: "203.0.113.10",
    });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({
            data: [
              {
                id: "host-1",
                user_id: "user-123",
                hetzner_server_id: 42,
                status: "running",
                created_at: "2026-04-23T10:00:00.000Z",
              },
            ],
            error: null,
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          neq: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0].status).toBe("provisioning");
  });
});
