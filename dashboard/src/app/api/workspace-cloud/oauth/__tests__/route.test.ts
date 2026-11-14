import { NextRequest } from "next/server";

import { POST } from "../route";
import { startWorkspaceCloudOAuth } from "@/lib/services/workspace-cloud-provisioner";

const mockRow: { current: { ipv4_address: string; api_server_key_encrypted: string; status: string } | null } = {
  current: null,
};

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              neq: () => ({
                maybeSingle: async () => ({ data: mockRow.current }),
              }),
            }),
          }),
        }),
      }),
    };
  },
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: () => "agent-api-key-0001",
}));

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: () => ({ success: true }),
  getIP: () => "203.0.113.9",
}));

jest.mock("@/lib/services/workspace-cloud-provisioner", () => ({
  startWorkspaceCloudOAuth: jest.fn(),
  pollWorkspaceCloudOAuth: jest.fn(),
}));

function startRequest() {
  return new NextRequest("http://localhost/api/workspace-cloud/oauth", {
    method: "POST",
    body: JSON.stringify({
      instanceId: "00000000-0000-4000-8000-000000000001",
      apiServerKey: "agent-api-key-0001",
      provider: "openai-codex",
      action: "start",
    }),
  });
}

describe("POST /api/workspace-cloud/oauth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRow.current = {
      ipv4_address: "203.0.113.20",
      api_server_key_encrypted: "encrypted",
      status: "running",
    };
  });

  it("returns an https device login URL and its code", async () => {
    (startWorkspaceCloudOAuth as jest.Mock).mockResolvedValue({
      ok: true,
      url: "https://auth.example.test/device",
      code: "ABCD-1234",
    });

    const response = await POST(startRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ url: "https://auth.example.test/device", code: "ABCD-1234" });
  });

  it("does not return a plain-http login URL that the owner would be sent to", async () => {
    (startWorkspaceCloudOAuth as jest.Mock).mockResolvedValue({
      ok: true,
      url: "http://auth.example.test/device",
      code: "ABCD-1234",
    });

    const response = await POST(startRequest());
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(JSON.stringify(json)).not.toContain("auth.example.test");
  });
});
