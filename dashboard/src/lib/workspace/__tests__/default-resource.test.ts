import { resolveDefaultHivraResource } from "../default-resource";

/**
 * The bare-visit landing decision. Getting this wrong is not a subtle bug — it
 * is the difference between clicking "Chat" and reaching a resource versus
 * reaching a page that says none exists.
 */
function supabaseReturning(rows: unknown, error: unknown = null) {
  const limit = jest.fn(async () => ({ data: rows, error }));
  const order = jest.fn(() => ({ limit }));
  const inFilter = jest.fn(() => ({ order }));
  const eq = jest.fn(() => ({ in: inFilter }));
  const select = jest.fn(() => ({ eq }));
  return {
    client: { from: jest.fn(() => ({ select })) } as never,
    spies: { select, eq, in: inFilter, order, limit },
  };
}

describe("default hivra resource", () => {
  it("prefers a RUNNING resource over a newer stopped one", async () => {
    // The whole point of the preference: landing on a stopped box is a worse
    // first impression than landing on a live one, even if the stopped box is
    // more recent.
    const { client } = supabaseReturning([
      { id: "stopped-newest", status: "stopped", created_at: "2026-09-18T10:00:00Z" },
      { id: "running-older", status: "running", created_at: "2026-09-17T10:00:00Z" },
    ]);

    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBe("running-older");
  });

  it("falls back to a starting resource when nothing is running", async () => {
    const { client } = supabaseReturning([
      { id: "stopped", status: "stopped", created_at: "2026-09-18T10:00:00Z" },
      { id: "starting", status: "provisioning", created_at: "2026-09-17T10:00:00Z" },
    ]);

    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBe("starting");
  });

  it("picks the newest of equally-ranked resources", async () => {
    const { client } = supabaseReturning([
      { id: "newer", status: "running", created_at: "2026-09-18T10:00:00Z" },
      { id: "older", status: "running", created_at: "2026-09-17T10:00:00Z" },
    ]);

    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBe("newer");
  });

  it("returns null for an account with no resources", async () => {
    const { client } = supabaseReturning([]);
    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBeNull();
  });

  it("returns null rather than throwing when the query fails", async () => {
    // A lookup failure must degrade to the old behaviour, not 500 the route.
    const { client } = supabaseReturning(null, { message: "boom" });
    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBeNull();
  });

  it("excludes deleted resources from the query", async () => {
    // A deleted row is a billing ghost, not a destination. The filter is part
    // of the contract, so assert it was applied rather than trusting the mock.
    const { client, spies } = supabaseReturning([]);
    await resolveDefaultHivraResource({ userId: "user_1", supabase: client });

    expect(spies.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(spies.in).toHaveBeenCalledWith(
      "status",
      expect.not.arrayContaining(["deleted"]),
    );
  });

  it("ignores a row whose id is missing or blank", async () => {
    const { client } = supabaseReturning([
      { id: "   ", status: "running", created_at: "2026-09-18T10:00:00Z" },
    ]);

    await expect(
      resolveDefaultHivraResource({ userId: "user_1", supabase: client }),
    ).resolves.toBeNull();
  });
});
