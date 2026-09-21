import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { POST } from "../route";
import { sshExec } from "@/lib/hetzner/ssh";
import { InstanceAccessError, ProfileService } from "@/lib/services/profile-service";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/services/profile-service", () => {
  const actual = jest.requireActual("@/lib/services/profile-service");
  return {
    ...actual,
    ProfileService: {
      ...actual.ProfileService,
      getHostIpForInstance: jest.fn(),
    },
  };
});

describe("POST /api/instances/[id]/workspaces/upload", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedGetHostIpForInstance =
    ProfileService.getHostIpForInstance as jest.MockedFunction<typeof ProfileService.getHostIpForInstance>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHostIpForInstance.mockResolvedValue("127.0.0.1");
    mockedSshExec.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
  });

  it("uploads files into a WebUI workspace folder without interpolating raw request text", async () => {
    const form = new FormData();
    form.set("path", "/workspace/projects/launch $(touch /tmp/path-pwned)");
    form.append("files", new File(['" && touch /tmp/pwned && echo "'], "notes $(id).txt"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/workspaces/upload", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockedGetHostIpForInstance).toHaveBeenCalledWith("inst_123", "user-123");
    expect(mockedSshExec).toHaveBeenCalledTimes(1);

    const command = String(mockedSshExec.mock.calls[0]?.[1]);
    expect(command).toContain("'/workspace/projects/launch $(touch /tmp/path-pwned)'");
    expect(command).toContain("'notes $(id).txt'");
    expect(command).toContain("base64 -d | docker exec");
    expect(command).not.toContain("touch /tmp/pwned");
    expect(command).not.toContain('TARGET_DIR="/workspace/projects/launch $(touch /tmp/path-pwned)"');
    expect(command).not.toContain('FILENAME="notes $(id).txt"');
  });

  it("rejects uploads outside the WebUI workspace root", async () => {
    const form = new FormData();
    form.set("path", "/etc");
    form.append("files", new File(["hello"], "notes.txt"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/workspaces/upload", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Upload folder must be inside /workspace");
    expect(mockedSshExec).not.toHaveBeenCalled();
  });

  it("returns an indistinguishable 404 before SSH for another tenant's instance", async () => {
    mockedAuth.mockResolvedValue({ userId: "foreign-user" } as Awaited<ReturnType<typeof auth>>);
    mockedGetHostIpForInstance.mockRejectedValue(new InstanceAccessError());
    const form = new FormData();
    form.set("path", "/workspace");
    form.append("files", new File(["controlled fixture"], "tenant-isolation.txt"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/owned-by-another-tenant/workspaces/upload", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "owned-by-another-tenant" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Instance not found" });
    expect(mockedGetHostIpForInstance).toHaveBeenCalledWith("owned-by-another-tenant", "foreign-user");
    expect(mockedSshExec).not.toHaveBeenCalled();
  });

  it("falls back to a safe filename when the browser sends a directory marker", async () => {
    const form = new FormData();
    form.set("path", "/workspace");
    form.append("files", new File(["hello"], "."));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst_123/workspaces/upload", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.uploaded[0]).toEqual({
      name: "upload",
      path: "/workspace/upload",
      size: 5,
    });

    const command = String(mockedSshExec.mock.calls[0]?.[1]);
    expect(command).toContain("FILENAME='upload'");
  });
});
