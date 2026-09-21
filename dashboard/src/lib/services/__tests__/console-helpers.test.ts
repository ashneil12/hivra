import { validateConsoleAccess, discoverContainerName } from "@/lib/services/console-helpers";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

interface SupabaseMockBuilder {
  select: jest.Mock;
  update: jest.Mock;
  upsert: jest.Mock;
  eq: jest.Mock;
  single: jest.Mock;
  then: (resolve: (val: { data: unknown; error: unknown }) => void) => void;
}

const createMockBuilder = (): SupabaseMockBuilder => {
    const builder = {
      select: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      then: (resolve: (val: { data: unknown; error: unknown }) => void) => resolve({ data: null, error: null }),
    };
    return builder as unknown as SupabaseMockBuilder;
  };

jest.mock("@/lib/supabase", () => {
  return {
    supabaseAdmin: {
      from: jest.fn(),
    },
  };
});

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

describe("console-helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("validateConsoleAccess", () => {
    it("returns 401 if not authenticated", async () => {
      (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
      const result = await validateConsoleAccess(Promise.resolve({ id: "instance-1" }));
      expect(result.errorResponse?.status).toBe(401);
    });

    it("returns 400 for bad id format", async () => {
      (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });
      const result = await validateConsoleAccess(Promise.resolve({ id: "inv@lid-id" }));
      expect(result.errorResponse?.status).toBe(400);
    });

    it("returns 404 if instance not found", async () => {
      (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });

      (supabaseAdmin!.from as unknown as jest.Mock).mockImplementation(() => {
        const builder = createMockBuilder();
        builder.single.mockImplementation(() => Promise.resolve({ data: null }));
        return builder;
      });

      const result = await validateConsoleAccess(Promise.resolve({ id: "inst-1" }));
      expect(result.errorResponse?.status).toBe(404);
    });

    it("returns 404 if instance offline", async () => {
      (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });

      (supabaseAdmin!.from as unknown as jest.Mock).mockImplementation(() => {
        const builder = createMockBuilder();
        builder.single.mockImplementation(() => Promise.resolve({ data: { id: "inst-1", user_id: "user-1" } }));
        return builder;
      });

      (resolveInstanceIpv4 as unknown as jest.Mock).mockResolvedValue(null);

      const result = await validateConsoleAccess(Promise.resolve({ id: "inst-1" }));
      expect(result.errorResponse?.status).toBe(404);
      expect(result.errorResponse?.json).toBeDefined(); // Testing it returned NextResponse
    });

    it("returns valid context if all checks pass", async () => {
      (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });

      (supabaseAdmin!.from as unknown as jest.Mock).mockImplementation(() => {
        const builder = createMockBuilder();
        builder.single.mockImplementation(() => Promise.resolve({ data: { id: "inst-1", user_id: "user-1" } }));
        return builder;
      });

      (resolveInstanceIpv4 as unknown as jest.Mock).mockResolvedValue("127.0.0.1");

      const result = await validateConsoleAccess(Promise.resolve({ id: "inst-1" }));
      expect(result.errorResponse).toBeNull();
      if (result.errorResponse) {
        throw new Error("Expected console access validation to succeed");
      }
      expect(result.hostIp).toBe("127.0.0.1");
      expect(result.userId).toBe("user-1");
    });
  });

  describe("discoverContainerName", () => {
    it("returns exact matched name via ssh command output", async () => {
      (sshExec as unknown as jest.Mock).mockResolvedValue({ stdout: "custom-agent-123\n", stderr: "" });
      const name = await discoverContainerName("127.0.0.1", "123");
      expect(name).toBe("custom-agent-123");
    });

    it("falls back if stdout is empty", async () => {
      (sshExec as unknown as jest.Mock).mockResolvedValue({ stdout: "", stderr: "error" });
      const name = await discoverContainerName("127.0.0.1", "123");
      expect(name).toBe("agent-123");
    });
  });
});
