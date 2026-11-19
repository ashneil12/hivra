import {
  checkClaim,
  claimLine,
  claimRepo,
  orderTypesByUse,
  proofHasLine,
  readCatalogOrder,
  readClaimView,
  resetCatalogOrderCache,
  startClaim,
} from "../catalog-claims";

// A small stand-in for the service-role client: one table of claims held in
// memory, and the use-per-type function answering from a fixed list.
type Row = Record<string, unknown>;
const claims: Row[] = [];
let useRows: Row[] = [];
let useCalls: Row[] = [];
let failNext: string | null = null;

function table() {
  const filters: [string, unknown][] = [];
  let patch: Row | null = null;
  const matching = () => claims.filter(row => filters.every(([column, value]) => row[column] === value));
  const fail = () => {
    if (!failNext) return null;
    const message = failNext;
    failNext = null;
    return { data: null, error: { message } };
  };
  const builder = {
    select: () => builder,
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      if (!patch) return builder;
      for (const row of matching()) Object.assign(row, patch);
      return Promise.resolve(fail() ?? { data: null, error: null });
    },
    maybeSingle: async () => fail() ?? { data: matching()[0] ?? null, error: null },
    limit: async (n: number) => fail() ?? { data: matching().slice(0, n), error: null },
    insert: async (row: Row) => {
      if (claims.some(existing => existing.profile_id === row.profile_id && existing.user_id === row.user_id)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      claims.push({ id: `claim-${claims.length + 1}`, status: "pending", check_result: null, checked_at: null, verified_at: null, ...row });
      return fail() ?? { data: null, error: null };
    },
    update(next: Row) {
      patch = next;
      return builder;
    },
  };
  return builder;
}

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => table(),
    rpc: async (_name: string, args: Row) => {
      useCalls.push(args);
      return { data: useRows, error: null };
    },
  },
}));

const fetchMock = jest.fn();
const NOW = new Date("2026-11-13T12:00:00Z");
const text = (body: string, status = 200) => new Response(body, { status });

beforeEach(() => {
  claims.length = 0;
  useRows = [];
  useCalls = [];
  failNext = null;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  resetCatalogOrderCache();
});

describe("what a claim is proven with", () => {
  it("reads the proof from the repository the catalog links, and from nowhere for a page without one", () => {
    expect(claimRepo("codex")).toBe("openai/codex");
    expect(claimRepo("hermes-computer")).toBe("NousResearch/hermes-agent");
    expect(claimRepo("openbot")).toBeNull();
    expect(claimRepo("ubuntu-desktop")).toBeNull();
    // A computer is not claimed, even one a project publishes.
    expect(claimRepo("omarchy")).toBeNull();
  });

  it("wants the line on a line of its own", () => {
    const value = "0123456789abcdef".repeat(2);
    expect(claimLine(value)).toBe(`hivra-claim=${value}`);
    expect(proofHasLine(`# Hivra\r\n  hivra-claim=${value}  \r\n`, value)).toBe(true);
    expect(proofHasLine(`hivra-claim=${value}0`, value)).toBe(false);
    expect(proofHasLine(`see hivra-claim=${value}`, value)).toBe(false);
    expect(proofHasLine("", value)).toBe(false);
  });
});

describe("claiming a page", () => {
  it("shows an unclaimed page and gives the person a line they keep", async () => {
    expect(await readClaimView("ana", "codex", NOW)).toEqual({
      profileId: "codex", name: "Codex", repo: "openai/codex", filePath: ".well-known/hivra.txt",
      claimed: false, mine: null, numbers: null,
    });

    const started = await startClaim("ana", "codex", NOW);
    expect(started?.mine).toEqual({
      status: "pending", line: expect.stringMatching(/^hivra-claim=[a-f0-9]{32}$/), lastCheck: null, checkedAt: null, verifiedAt: null,
    });
    expect(claims[0]).toMatchObject({ profile_id: "codex", user_id: "ana", repo: "openai/codex" });

    const again = await startClaim("ana", "codex", NOW);
    expect(again?.mine?.line).toBe(started?.mine?.line);
    expect(claims).toHaveLength(1);
    // Someone else sees neither her claim nor her line.
    expect((await readClaimView("ben", "codex", NOW)).mine).toBeNull();
  });

  it("refuses a page with no repository to read", async () => {
    expect(await startClaim("ana", "openbot", NOW)).toBeNull();
    expect(await checkClaim("ana", "openbot", NOW)).toBeNull();
    expect(await readClaimView("ana", "ubuntu-desktop", NOW)).toMatchObject({ repo: null, claimed: false, mine: null });
    expect(claims).toHaveLength(0);
  });

  it("has nothing to check before a claim is started", async () => {
    expect(await checkClaim("ana", "codex", NOW)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records what a check found without proving anything", async () => {
    const line = (await startClaim("ana", "codex", NOW))!.mine!.line;

    fetchMock.mockResolvedValueOnce(text("Not Found", 404));
    expect((await checkClaim("ana", "codex", NOW))?.mine).toMatchObject({ status: "pending", lastCheck: "file_missing", checkedAt: NOW.toISOString() });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/openai/codex/HEAD/.well-known/hivra.txt",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );

    fetchMock.mockResolvedValueOnce(text("hivra-claim=ffffffffffffffffffffffffffffffff\n"));
    expect((await checkClaim("ana", "codex", NOW))?.mine?.lastCheck).toBe("line_missing");

    fetchMock.mockResolvedValueOnce(text("busy", 503));
    expect((await checkClaim("ana", "codex", NOW))?.mine?.lastCheck).toBe("unreachable");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const view = await checkClaim("ana", "codex", NOW);
    expect(view?.mine).toMatchObject({ status: "pending", lastCheck: "unreachable", line });
    expect(view).toMatchObject({ claimed: false, numbers: null });
  });

  it("proves the claim when the line is in the file, and then shows the maker their numbers", async () => {
    const line = (await startClaim("ana", "hermes-computer", NOW))!.mine!.line;
    useRows = [
      { agent_type: "codex", people: 9, active_hours: 90, launches: 9, running_now: 9, two_week_launches: 9, two_week_kept: 9 },
      { agent_type: "hermes", people: 3, active_hours: "41", launches: 5, running_now: 2, two_week_launches: 4, two_week_kept: 3 },
    ];
    fetchMock.mockResolvedValueOnce(text(`# Proof for Hivra\n${line}\n`));

    const view = await checkClaim("ana", "hermes-computer", NOW);
    expect(view).toMatchObject({
      claimed: true,
      mine: { status: "verified", lastCheck: "verified", verifiedAt: NOW.toISOString() },
      numbers: { days: 30, people: 3, launches: 5, activeHours: 41, runningNow: 2, twoWeekLaunches: 4, twoWeekKept: 3 },
    });
    expect(useCalls[0]).toEqual({ p_from: "2026-10-14T12:00:00.000Z", p_to: NOW.toISOString() });

    // Proven once: a later check does not go back to the repository.
    await checkClaim("ana", "hermes-computer", NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Everyone sees the page is claimed; only the maker sees the numbers.
    expect(await readClaimView("ben", "hermes-computer", NOW)).toMatchObject({ claimed: true, mine: null, numbers: null });
  });

  it("shows zeros for an agent nobody has used yet", async () => {
    const line = (await startClaim("ana", "aeon", NOW))!.mine!.line;
    fetchMock.mockResolvedValueOnce(text(line));
    expect((await checkClaim("ana", "aeon", NOW))?.numbers).toEqual({
      days: 30, people: 0, launches: 0, activeHours: 0, runningNow: 0, twoWeekLaunches: 0, twoWeekKept: 0,
    });
  });

  it("fails loudly when the database does", async () => {
    failNext = "down";
    await expect(readClaimView("ana", "codex", NOW)).rejects.toThrow();
  });
});

describe("the catalog's order", () => {
  it("puts the types more people use first and leaves out the unused", () => {
    expect(orderTypesByUse([
      { agent_type: "aeon", people: 0, active_hours: 0 },
      { agent_type: "codex", people: 2, active_hours: 10 },
      { agent_type: "openclaw", people: 5, active_hours: 1 },
      { agent_type: "claude-code", people: 2, active_hours: 30 },
      { agent_type: "agent-zero", people: 2, active_hours: 10 },
    ])).toEqual(["openclaw", "claude-code", "agent-zero", "codex"]);
  });

  it("is read at most once every ten minutes", async () => {
    useRows = [{ agent_type: "codex", people: 1, active_hours: 1 }];
    expect(await readCatalogOrder(NOW)).toEqual(["codex"]);
    useRows = [{ agent_type: "openclaw", people: 1, active_hours: 1 }];
    expect(await readCatalogOrder(new Date(NOW.getTime() + 9 * 60_000))).toEqual(["codex"]);
    expect(await readCatalogOrder(new Date(NOW.getTime() + 11 * 60_000))).toEqual(["openclaw"]);
    expect(useCalls).toHaveLength(2);
  });
});
