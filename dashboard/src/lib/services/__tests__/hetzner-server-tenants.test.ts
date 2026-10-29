import type { SupabaseClient } from "@supabase/supabase-js";

import { countOtherLiveRowsOnHetznerServer } from "../hetzner-server-tenants";

type Answer = { count: number | null; error: { message: string } | null };
type Query = { column: string; value: unknown; neq: Array<[string, unknown]> };

// A thenable select chain that records each eq/neq filter and answers the
// awaited count from `answerFor(column, value)`.
function fakeSupabase(answerFor: (column: string, value: unknown) => Answer) {
  const queries: Query[] = [];
  const from = jest.fn(() => {
    let current: Query | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn(() => chain);
    chain.eq = jest.fn((column: string, value: unknown) => {
      current = { column, value, neq: [] };
      queries.push(current);
      return chain;
    });
    chain.neq = jest.fn((column: string, value: unknown) => {
      current!.neq.push([column, value]);
      return chain;
    });
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(answerFor(current!.column, current!.value)).then(resolve, reject);
    return chain;
  });
  return { client: { from } as unknown as SupabaseClient, from, queries };
}

const ok = (count: number): Answer => ({ count, error: null });
const failed = (message: string): Answer => ({ count: null, error: { message } });

describe("countOtherLiveRowsOnHetznerServer", () => {
  it("counts other non-deleted rows on the server, excluding this instance", async () => {
    const { client, queries } = fakeSupabase((column) => (column === "hetzner_server_id" ? ok(2) : ok(0)));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
    });

    expect(result).toEqual({ ok: true, otherLiveRows: 2 });
    expect(queries).toEqual([
      {
        column: "hetzner_server_id",
        value: 42,
        neq: [
          ["id", "inst-a"],
          ["status", "deleted"],
        ],
      },
    ]);
  });

  it("does not query the host when no host id is given", async () => {
    const { client, queries } = fakeSupabase(() => ok(0));

    await countOtherLiveRowsOnHetznerServer(client, { instanceId: "inst-a", hetznerServerId: 42, hostId: null });

    expect(queries.map((query) => query.column)).toEqual(["hetzner_server_id"]);
  });

  it("counts a sibling linked only by host id, when the server key finds none", async () => {
    // Regression (F011): the server key alone missed host-linked rows that
    // carry no hetzner_server_id, so their shared server was destroyed.
    const { client, queries } = fakeSupabase((column) => (column === "host_id" ? ok(1) : ok(0)));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
      hostId: "host-456",
    });

    expect(result).toEqual({ ok: true, otherLiveRows: 1 });
    expect(queries).toContainEqual({
      column: "host_id",
      value: "host-456",
      neq: [
        ["id", "inst-a"],
        ["status", "deleted"],
      ],
    });
  });

  it("does not add the two keys together when one row carries both", async () => {
    // A shared row is linked by both hetzner_server_id and host_id. It is one
    // sibling, so the larger count is returned, not the sum.
    const { client } = fakeSupabase(() => ok(1));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
      hostId: "host-456",
    });

    expect(result).toEqual({ ok: true, otherLiveRows: 1 });
  });

  it("leaves out the rows of the same account sweep, and still counts any other live row", async () => {
    // F011 sweep: the sweep's own agents are removed together, so they must not
    // block each other. Any other live row on the server still counts.
    const { client, queries } = fakeSupabase(() => ok(1));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
      excludeInstanceIds: ["inst-b"],
    });

    expect(result).toEqual({ ok: true, otherLiveRows: 1 });
    expect(queries).toEqual([
      {
        column: "hetzner_server_id",
        value: 42,
        neq: [
          ["id", "inst-a"],
          ["id", "inst-b"],
          ["status", "deleted"],
        ],
      },
    ]);
  });

  it("fails closed when the server count errors", async () => {
    const { client } = fakeSupabase((column) =>
      column === "hetzner_server_id" ? failed("connection reset") : ok(0),
    );

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
      hostId: "host-456",
    });

    expect(result).toEqual({ ok: false, message: "connection reset" });
  });

  it("fails closed when the host count errors, even if the server count is zero", async () => {
    // An unknown count is not zero: a failed host read must refuse the delete.
    const { client } = fakeSupabase((column) => (column === "host_id" ? failed("timeout") : ok(0)));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
      hostId: "host-456",
    });

    expect(result).toEqual({ ok: false, message: "timeout" });
  });

  it("fails closed when the count is not returned", async () => {
    const { client } = fakeSupabase(() => ({ count: null, error: null }));

    const result = await countOtherLiveRowsOnHetznerServer(client, {
      instanceId: "inst-a",
      hetznerServerId: 42,
    });

    expect(result).toEqual({ ok: false, message: "live-row count was not returned" });
  });
});
