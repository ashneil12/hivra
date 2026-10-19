/** @jest-environment node */
// The agent page's "Update available" for Hermes boxes. Before any release is
// registered (production has none), every box follows its floating :stable
// tag and its UPDATE pulls exactly that tag, but the page never said a newer
// build was waiting: owners had to know to open the console. These tests pin
// the offer to the real comparison: the box's reported digest against the
// digest GHCR serves for the tag the box's update pulls.
import { auth } from "@clerk/nextjs/server";

import { clearFloatingImageCache } from "@/lib/hermes-releases/floating";
import { loadReleases } from "@/lib/hermes-releases/store";

import { GET } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hermes-releases/store", () => ({ loadReleases: jest.fn() }));

const row: { current: Record<string, unknown> | null } = { current: null };
// A small filter-aware stand-in: the row comes back only when every .eq/.neq
// the route applies matches it, so dropping the ownership filter fails a test.
jest.mock("@/lib/supabase", () => {
  const from = jest.fn(() => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn(() => chain);
    chain.eq = jest.fn((column: string, value: unknown) => { filters.push((r) => r[column] === value); return chain; });
    chain.neq = jest.fn((column: string, value: unknown) => { filters.push((r) => r[column] !== value); return chain; });
    chain.maybeSingle = jest.fn(async () => ({
      data: row.current && filters.every((match) => match(row.current!)) ? row.current : null,
      error: null,
    }));
    return chain;
  });
  return { supabaseAdmin: { from } };
});

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const PROD_REPO = "ghcr.io/ashneil12/vanilla-hermes-agent";

function box(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst_1",
    user_id: "user_1",
    status: "running",
    config: {},
    release_channel: "stable",
    agent_image_digest: OLD,
    agent_version: null,
    update_health: "ok",
    update_health_detail: null,
    update_health_at: null,
    update_stack_version: 2,
    agent_image_reported_at: "2026-10-19T17:00:00Z",
    ...overrides,
  };
}

function ghcr(digest: string | null) {
  const fn = jest.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.startsWith("https://ghcr.io/token")) return new Response(JSON.stringify({ token: "t" }));
    if (digest === null) return new Response("", { status: 503 });
    return new Response("{}", { headers: { "docker-content-digest": digest } });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function read() {
  const res = await GET(new Request("http://localhost/api/instances/inst_1/release-status"), {
    params: Promise.resolve({ id: "inst_1" }),
  });
  return { status: res.status, body: await res.json() };
}

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  clearFloatingImageCache();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  (loadReleases as jest.Mock).mockResolvedValue([]);
  row.current = box();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => { global.fetch = realFetch; });

describe("GET /api/instances/[id]/release-status", () => {
  it("offers an update when the box's floating tag now points at a newer build", async () => {
    const fetchImpl = ghcr(NEW);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      running: true,
      governed: false,
      source: "floating",
      updateAvailable: true,
      direction: "upgrade",
      target: { version: "stable", digest: NEW },
      currentDigest: OLD,
    });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://ghcr.io/v2/ashneil12/vanilla-hermes-agent/manifests/stable`);
  });

  it("offers nothing when the box already runs what its tag points at", async () => {
    ghcr(OLD);
    const { body } = await read();
    expect(body.data).toMatchObject({ governed: false, source: "floating", updateAvailable: false, direction: "none", target: null });
  });

  it("follows the box's own pinned image repository and tag", async () => {
    row.current = box({ config: { webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent-canary:stable" } });
    const fetchImpl = ghcr(NEW);
    const { body } = await read();
    expect(body.data.updateAvailable).toBe(true);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://ghcr.io/v2/ashneil12/vanilla-hermes-agent-canary/manifests/stable`);
  });

  it("does not guess for a box that has never reported its build", async () => {
    row.current = box({ agent_image_digest: null });
    const fetchImpl = ghcr(NEW);
    const { body } = await read();
    expect(body.data).toMatchObject({ source: null, updateAvailable: false, target: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows no notice, and does not fail, when the tag cannot be read", async () => {
    ghcr(null);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ source: null, updateAvailable: false, target: null });
  });

  it("leaves a governed box to the release registry", async () => {
    const release = {
      id: "rel_1", image_repo: PROD_REPO, version: "2026.10.18-abc1234", digest: NEW, channel: "stable",
      rollout_percent: 100, pilot_instance_ids: [], halted: false, halted_reason: null, halted_at: null,
      halted_by: null, notes: null, created_by: "ci", created_at: "2026-10-18T00:00:00Z",
      promoted_at: "2026-10-18T01:00:00Z", updated_at: "2026-10-18T01:00:00Z",
    };
    (loadReleases as jest.Mock).mockResolvedValue([release]);
    const fetchImpl = ghcr(`sha256:${"c".repeat(64)}`);
    const { body } = await read();
    expect(body.data).toMatchObject({
      governed: true, source: "release", updateAvailable: true, target: { version: "2026.10.18-abc1234", digest: NEW },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 404 for a box the caller does not own, or one that was deleted", async () => {
    ghcr(NEW);
    row.current = box({ user_id: "someone_else" });
    expect((await read()).status).toBe(404);
    row.current = box({ status: "deleted" });
    expect((await read()).status).toBe(404);
  });

  it("tells the page a stopped box can't start an update yet", async () => {
    row.current = box({ status: "stopped" });
    ghcr(NEW);
    const { body } = await read();
    expect(body.data).toMatchObject({ running: false, updateAvailable: true });
  });

  it("answers 401 without a session", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const { status } = await read();
    expect(status).toBe(401);
  });
});
