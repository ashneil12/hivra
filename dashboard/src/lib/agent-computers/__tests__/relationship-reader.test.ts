import { execFileSync } from "node:child_process";
import path from "node:path";
import { CanonicalRelationshipSnapshotSchema, type CanonicalRelationshipSnapshot } from "../relationship-snapshot";
import { createCanonicalRelationshipReader, CanonicalRelationshipReadError } from "../relationship-reader";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

let before: CanonicalRelationshipSnapshot;
let after: CanonicalRelationshipSnapshot;
beforeAll(() => {
  const fixtures = JSON.parse(execFileSync(process.execPath, [
    path.resolve(process.cwd(), "scripts/test-hivra-canonical-relationship-reader.cjs"), "--json",
  ], { encoding: "utf8", timeout: 15_000 }));
  before = CanonicalRelationshipSnapshotSchema.parse(fixtures.before);
  after = CanonicalRelationshipSnapshotSchema.parse(fixtures.after);
});

describe("canonical relationship reader", () => {
  it("accepts actual PostgreSQL snapshots without forcing current bindings into launch provenance", () => {
    expect(before.bindings).toEqual([]);
    expect(after.source.resourceKind).toBe("computer");
    expect(after.identities).toHaveLength(1);
    expect(after.bindings[0].status).toBe("detached");
    expect(after.installations[0].status).toBe("installing");
    expect(after.lifecycle.sourceEventId).not.toBe(after.bindings[0].sourceEventId);
  });

  it("queries only the authenticated owner and exact canonical computer", async () => {
    const rpc = jest.fn().mockResolvedValue({ data: after, error: null });
    const reader = createCanonicalRelationshipReader({ rpc });
    expect(await reader.read(after.ownerId, after.computerId)).toEqual(after);
    expect(rpc).toHaveBeenCalledWith("read_hivra_canonical_computer_relationships", {
      p_owner: after.ownerId, p_computer_id: after.computerId,
    });
    await expect(reader.read("different-owner", after.computerId)).rejects.toThrow(CanonicalRelationshipReadError);
    await expect(reader.read(after.ownerId, after.source.id)).rejects.toThrow(CanonicalRelationshipReadError);
  });

  it("keeps not-found distinct from storage failure and never exposes raw diagnostics", async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const reader = createCanonicalRelationshipReader({ rpc });
    expect(await reader.read(after.ownerId, after.computerId)).toBeNull();
    rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE_DATABASE_DIAGNOSTIC" } });
    await expect(reader.read(after.ownerId, after.computerId)).rejects.toThrow("Computer relationships are unavailable");
    rpc.mockRejectedValue(new Error("PRIVATE_TRANSPORT_DIAGNOSTIC"));
    await expect(reader.read(after.ownerId, after.computerId)).rejects.toThrow(CanonicalRelationshipReadError);
    rpc.mockResolvedValue(null);
    await expect(reader.read(after.ownerId, after.computerId)).rejects.toThrow(CanonicalRelationshipReadError);
    for (const invalid of [{ data: null }, ...[false, 0, "", undefined].map(error => ({ data: null, error })),
      Object.assign([], { data: null, error: null }), Object.create({ data: null, error: null })]) {
      rpc.mockResolvedValue(invalid);
      await expect(reader.read(after.ownerId, after.computerId)).rejects.toThrow(CanonicalRelationshipReadError);
    }
  });

  it("rejects malformed or future contracts rather than returning an empty inventory", () => {
    for (const malformed of [
      { ...after, contractVersion: "future" },
      { ...after, secret: "unexpected" },
      { ...after, relationshipAuthority: { ...after.relationshipAuthority, generation: "not-an-integer" } },
      { ...after, relationshipAuthority: { ...after.relationshipAuthority, generation: "9223372036854775808" } },
      { ...after, identities: after.identities.map(identity => ({ ...identity, ownerId: "different-owner" })) },
      { ...after, identities: [] },
      { ...after, bindings: [...after.bindings, ...after.bindings] },
      { ...after, installations: after.installations.map(installation => ({ ...installation, computerId: after.source.id })) },
      { ...after, bindings: after.bindings.map(binding => ({ ...binding, status: "active" })) },
      { ...after, source: { ...after.source, alias: "wrong" } },
    ]) expect(CanonicalRelationshipSnapshotSchema.safeParse(malformed).success).toBe(false);
  });

  it("does not call storage for invalid identifiers or missing database configuration", async () => {
    const rpc = jest.fn();
    await expect(createCanonicalRelationshipReader({ rpc }).read("", "bad")).rejects.toThrow(CanonicalRelationshipReadError);
    expect(rpc).not.toHaveBeenCalled();
    await expect(createCanonicalRelationshipReader(null).read(after.ownerId, after.computerId)).rejects.toThrow(CanonicalRelationshipReadError);
  });
});
