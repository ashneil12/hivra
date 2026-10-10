import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { isRegistryMissingError, resolveUpdateImagePolicy } from "../live-update";

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const REPO = "ghcr.io/example/agent";
const BOX = "11111111-1111-4111-8111-111111111111";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

function release(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `rel-${n}`, image_repo: REPO, version: `1.0.${n}`, digest: n === 1 ? D1 : D2, channel: "stable",
    rollout_percent: 100, pilot_instance_ids: [], halted: false,
    promoted_at: `2026-10-0${n}T00:00:00Z`, created_at: `2026-10-0${n}T00:00:00Z`, ...overrides,
  };
}

function db(releases: Record<string, unknown>[], digest: string | null = D1) {
  const memory = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hermes_releases"],
    seed: {
      hermes_instances: [{ id: BOX, config: { webuiAgentImage: `${REPO}:stable` }, release_channel: "stable", agent_image_digest: digest, agent_version: null, update_health: null }],
      hermes_releases: releases,
    },
  });
  return memory.db as unknown as SupabaseClient;
}

describe("resolveUpdateImagePolicy", () => {
  it("pins a release update to the newer release", async () => {
    const { policy } = await resolveUpdateImagePolicy(db([release(1), release(2)]), BOX, "release");
    expect(policy).toEqual({ kind: "pinned", ref: `${REPO}@${D2}`, digest: D2 });
  });

  it("keeps the image for a release update that has nothing newer to offer", async () => {
    expect((await resolveUpdateImagePolicy(db([release(1), release(2)], D2), BOX, "release")).policy).toEqual({ kind: "keep" });
  });

  it("keeps the image for any update that is not a release update, even when a newer release exists", async () => {
    expect((await resolveUpdateImagePolicy(db([release(1), release(2)]), BOX, "current")).policy).toEqual({ kind: "keep" });
  });

  it("brings a box whose digest was never reported onto a release", async () => {
    expect((await resolveUpdateImagePolicy(db([release(1)], null), BOX, "release")).policy).toEqual({
      kind: "pinned", ref: `${REPO}@${D1}`, digest: D1,
    });
  });

  it("moves a box off a halted release", async () => {
    const releases = [release(1), release(2, { halted: true, halted_reason: "bad", halted_at: "2026-10-03T00:00:00Z" })];
    expect((await resolveUpdateImagePolicy(db(releases, D2), BOX, "release")).policy).toEqual({ kind: "pinned", ref: `${REPO}@${D1}`, digest: D1 });
  });

  it("has no policy for a box the registry does not govern", async () => {
    expect((await resolveUpdateImagePolicy(db([]), BOX, "release")).policy).toBeUndefined();
    expect((await resolveUpdateImagePolicy(db([release(1, { image_repo: "ghcr.io/other/agent" })]), BOX, "release")).policy).toBeUndefined();
  });

  it("treats an environment the migration has not reached as ungoverned, but surfaces real database errors", async () => {
    const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column does not exist" } }) }) }) }) } as unknown as SupabaseClient;
    expect((await resolveUpdateImagePolicy(missing, BOX, "release")).policy).toBeUndefined();
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57P01", message: "terminating connection" } }) }) }) }) } as unknown as SupabaseClient;
    await expect(resolveUpdateImagePolicy(broken, BOX, "release")).rejects.toThrow();
    expect(isRegistryMissingError({ code: "42P01" })).toBe(true);
    expect(isRegistryMissingError({ code: "57P01" })).toBe(false);
  });

  it("never pulls or moves the image of a box that follows upstream Hermes by itself", async () => {
    const memory = createSupabaseMemoryDb({
      tables: ["hermes_instances", "hermes_releases"],
      seed: {
        hermes_instances: [{ id: BOX, config: { webuiAgentImage: "hivra-local/hermes:stable" }, release_channel: "stable", agent_image_digest: null, agent_version: null, update_health: null }],
        hermes_releases: [release(1), release(2)],
      },
    });
    const { policy } = await resolveUpdateImagePolicy(memory.db as unknown as SupabaseClient, BOX, "release");
    expect(policy).toEqual({ kind: "keep" });
  });
});
