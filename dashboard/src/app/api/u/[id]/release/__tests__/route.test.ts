import { NextRequest } from "next/server";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { GET } from "../route";

const mockDb: { current: unknown } = { current: null };

jest.mock("@/lib/crypto", () => ({ decryptApiKey: jest.fn((value: string) => value) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const REPO = "ghcr.io/example/agent";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

function release(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `rel-${n}`,
    image_repo: REPO,
    version: `1.0.${n}`,
    digest: n === 1 ? D1 : D2,
    channel: "stable",
    rollout_percent: 100,
    pilot_instance_ids: [],
    halted: false,
    promoted_at: `2026-10-0${n}T00:00:00Z`,
    created_at: `2026-10-0${n}T00:00:00Z`,
    ...overrides,
  };
}

function setup(releases: Record<string, unknown>[], instance: Record<string, unknown> = {}) {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hermes_releases"],
    seed: {
      hermes_instances: [
        { id: ID, api_server_key_encrypted: "secret", deleted_at: null, release_channel: "stable", agent_image_digest: null, config: null, ...instance },
      ],
      hermes_releases: releases,
    },
  });
  mockDb.current = memory.db;
}

function ask(query = `repo=${REPO}`, auth: string | null = "Bearer secret") {
  return GET(
    new NextRequest(`http://localhost/api/u/${ID}/release?${query}`, { headers: auth ? { authorization: auth } : {} }),
    { params: Promise.resolve({ id: ID }) }
  );
}

describe("GET /api/u/[id]/release", () => {
  it("tells a box on an older release to roll to the newer one, by digest", async () => {
    setup([release(1), release(2)]);
    const res = await ask(`repo=${REPO}&cur=${D1}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      `action=roll\nimage=${REPO}@${D2}\ndigest=${D2}\nversion=1.0.2\ndirection=upgrade\n`
    );
  });

  it("answers none when the box already runs its target", async () => {
    setup([release(1), release(2)]);
    const text = await (await ask(`repo=${REPO}&cur=${D2}`)).text();
    expect(text).toContain("action=none");
    expect(text).not.toContain("image=");
  });

  it("uses the digest the box measured over the last one stored", async () => {
    setup([release(1), release(2)], { agent_image_digest: D1 });
    expect(await (await ask(`repo=${REPO}&cur=${D2}`)).text()).toContain("action=none");
  });

  it("holds when nothing is offered, so a roller never falls back to a floating tag", async () => {
    setup([release(1, { halted: true })]);
    expect(await (await ask()).text()).toBe("action=hold\nreason=no_release\n");
    setup([]);
    expect(await (await ask()).text()).toBe("action=hold\nreason=no_release\n");
  });

  it("does not offer a pilot-stage release to a box outside the pilot", async () => {
    setup([release(1), release(2, { rollout_percent: 0 })]);
    expect(await (await ask(`repo=${REPO}&cur=${D1}`)).text()).toContain("action=none");
    setup([release(1), release(2, { rollout_percent: 0, pilot_instance_ids: [ID] })]);
    expect(await (await ask(`repo=${REPO}&cur=${D1}`)).text()).toContain(`image=${REPO}@${D2}`);
  });

  it("rejects a missing or wrong bearer", async () => {
    setup([release(1)]);
    expect((await ask(`repo=${REPO}`, null)).status).toBe(401);
    expect((await ask(`repo=${REPO}`, "Bearer wrong")).status).toBe(401);
  });
});
