import { NextRequest } from "next/server";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { GET, POST } from "../route";
import { POST as POST_ID } from "../[id]/route";

const mockDb: { current: unknown } = { current: null };
const mockAdmin = { current: { userId: "user_admin", email: "admin@example.com" } as { userId: string | null; email: string } };

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: mockAdmin.current.userId })),
  currentUser: jest.fn(async () => ({
    primaryEmailAddress: { emailAddress: mockAdmin.current.email, verification: { status: "verified" } },
  })),
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn().mockResolvedValue({}) }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));
jest.mock("@/lib/hermes-releases/registry", () => ({
  ...jest.requireActual("@/lib/hermes-releases/registry"),
  resolveGhcrTag: jest.fn(async () => `sha256:${"c".repeat(64)}`),
}));

const REPO = "ghcr.io/example/agent";
const PILOT = "22222222-2222-4222-8222-222222222222";
const RELEASE = "44444444-4444-4444-8444-444444444444";

function json(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.OPS_ADMIN_EMAILS = "admin@example.com";
  mockAdmin.current = { userId: "user_admin", email: "admin@example.com" };
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hermes_releases", "hermes_release_events"],
    seed: { hermes_instances: [{ id: PILOT, name: "pilot", deleted_at: null, status: "running", agent_image_digest: null, update_health: null }] },
  });
  mockDb.current = memory.db;
});

describe("ops hermes-releases API", () => {
  it("refuses callers who are not ops admins", async () => {
    mockAdmin.current = { userId: "user_other", email: "other@example.com" };
    expect((await GET()).status).toBe(403);
    expect((await POST(json("/api/ops/hermes-releases", { imageRepo: REPO, tag: "v1" }))).status).toBe(403);
    mockAdmin.current = { userId: null, email: "" };
    expect((await GET()).status).toBe(401);
  });

  it("registers by tag, resolving the digest from the registry", async () => {
    const created = await POST(json("/api/ops/hermes-releases", { imageRepo: REPO, tag: "v1-abc1234" }));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data.release).toMatchObject({ version: "v1-abc1234", digest: `sha256:${"c".repeat(64)}`, stage: "registered" });
  });

  it("registering the same image twice returns the existing release", async () => {
    const body = { imageRepo: REPO, digest: `sha256:${"d".repeat(64)}`, version: "1.0.0" };
    const first = await POST(json("/api/ops/hermes-releases", body));
    const second = await POST(json("/api/ops/hermes-releases", body));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).data.created).toBe(false);
  });

  it("walks a release canary -> pilot -> 10% -> 100% and can halt it", async () => {
    const memory = createSupabaseMemoryDb({
      tables: ["hermes_instances", "hermes_releases", "hermes_release_events"],
      seed: {
        hermes_instances: [{ id: PILOT, name: "pilot", deleted_at: null }],
        hermes_releases: [{ id: RELEASE, image_repo: REPO, version: "1.0.0", digest: `sha256:${"e".repeat(64)}`, channel: "canary", rollout_percent: 0, pilot_instance_ids: [], halted: false, promoted_at: null }],
      },
    });
    mockDb.current = memory.db;
    const step = async (body: unknown) => {
      const res = await POST_ID(json(`/api/ops/hermes-releases/${RELEASE}`, body), { params: Promise.resolve({ id: RELEASE }) });
      return { status: res.status, data: (await res.json()).data };
    };

    expect((await step({ action: "promote" })).data.release.stage).toBe("canary");
    expect((await step({ action: "promote" })).status).toBe(400); // pilot needs a box
    expect((await step({ action: "promote", pilotInstanceId: "33333333-3333-4333-8333-333333333333" })).status).toBe(404);
    expect((await step({ action: "promote", pilotInstanceId: PILOT })).data.release.stage).toBe("pilot");
    expect((await step({ action: "promote" })).data.release).toMatchObject({ stage: "ten_percent", rollout_percent: 10 });
    expect((await step({ action: "promote" })).data.release).toMatchObject({ stage: "full", rollout_percent: 100 });
    expect((await step({ action: "promote" })).status).toBe(409);

    const halted = await step({ action: "halt", reason: "regression found" });
    expect(halted.data.release).toMatchObject({ halted: true, halted_reason: "regression found" });
    expect((await step({ action: "promote", to: "full" })).status).toBe(409);
    expect((await step({ action: "unhalt" })).data.release.halted).toBe(false);
  });

  it("requires a tag, or a digest with its version", async () => {
    expect((await POST(json("/api/ops/hermes-releases", { imageRepo: REPO }))).status).toBe(400);
    expect((await POST(json("/api/ops/hermes-releases", { imageRepo: REPO, digest: `sha256:${"d".repeat(64)}` }))).status).toBe(400);
  });
});
