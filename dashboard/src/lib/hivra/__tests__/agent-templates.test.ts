import {
  createTemplateFromAgent,
  listUserTemplates,
  getTemplateForLaunch,
  setTemplateVisibility,
  getPublicTemplateByShareToken,
  deleteTemplate,
} from "../agent-templates";
import { snapshotInstalledTemplateSkillIds } from "../template-skills";

// Keep the real coerceSkillIds/resolveTemplateSkillIds; stub only the box round-trip.
jest.mock("../template-skills", () => {
  const actual = jest.requireActual("../template-skills");
  return { ...actual, snapshotInstalledTemplateSkillIds: jest.fn() };
});
const mockSnapshot = snapshotInstalledTemplateSkillIds as jest.MockedFunction<
  typeof snapshotInstalledTemplateSkillIds
>;

// ---------------------------------------------------------------------------
// A tiny in-memory stand-in for the supabaseAdmin query builder. Each table is
// backed by an array of rows; the builder records the active filters/payload and
// resolves on the terminal call (single / maybeSingle / order / select). This is
// enough to exercise the template lib's read/write paths without a real DB.
// ---------------------------------------------------------------------------

interface TableStore {
  rows: Record<string, unknown>[];
}

const tables: Record<string, TableStore> = {
  hivra_agents: { rows: [] },
  agent_templates: { rows: [] },
};

function resetTables() {
  tables.hivra_agents.rows = [];
  tables.agent_templates.rows = [];
}

let lastInsert: Record<string, unknown> | null = null;
let lastUpdate: Record<string, unknown> | null = null;

function makeBuilder(table: string) {
  const store = tables[table];
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let insertPayload: Record<string, unknown> | null = null;
  let updatePayload: Record<string, unknown> | null = null;

  const matches = (row: Record<string, unknown>) => filters.every(([k, v]) => row[k] === v);

  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return builder;
    },
    order() {
      // terminal for list(): resolve all matching rows
      return Promise.resolve({ data: store.rows.filter(matches), error: null });
    },
    insert(payload: Record<string, unknown>) {
      op = "insert";
      insertPayload = payload;
      lastInsert = payload;
      return builder;
    },
    update(payload: Record<string, unknown>) {
      op = "update";
      updatePayload = payload;
      lastUpdate = payload;
      return builder;
    },
    delete() {
      op = "delete";
      return builder;
    },
    maybeSingle() {
      const found = store.rows.find(matches) ?? null;
      return Promise.resolve({ data: found, error: null });
    },
    single() {
      if (op === "insert" && insertPayload) {
        const row = { id: `tmpl-${store.rows.length + 1}`, ...insertPayload };
        store.rows.push(row);
        return Promise.resolve({ data: row, error: null });
      }
      if (op === "update" && updatePayload) {
        const idx = store.rows.findIndex(matches);
        if (idx >= 0) {
          store.rows[idx] = { ...store.rows[idx], ...updatePayload };
          return Promise.resolve({ data: store.rows[idx], error: null });
        }
        return Promise.resolve({ data: null, error: { message: "not found" } });
      }
      const found = store.rows.find(matches) ?? null;
      return Promise.resolve({ data: found, error: null });
    },
    then(resolve: (value: { data: unknown; error: null }) => void) {
      // terminal for delete().select() and bare awaits
      if (op === "delete") {
        const removed = store.rows.filter(matches);
        tables[table].rows = store.rows.filter((r) => !matches(r));
        resolve({ data: removed.map((r) => ({ id: r.id })), error: null });
        return;
      }
      resolve({ data: store.rows.filter(matches), error: null });
    },
  };
  return builder;
}

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => makeBuilder(table),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

beforeEach(() => {
  resetTables();
  lastInsert = null;
  lastUpdate = null;
  mockSnapshot.mockReset();
  mockSnapshot.mockResolvedValue([]);
});

describe("createTemplateFromAgent", () => {
  it("snapshots the portable identity and NEVER copies the encrypted key", async () => {
    tables.hivra_agents.rows.push({
      id: "agent-1",
      user_id: "owner",
      type: "claude-code",
      name: "My Builder",
      goal: "build",
      context: "secret internal notes",
      personality: "direct",
      emoji: "🔨",
      llm_config: { provider: "venice", mode: "byok", model: null, enabledAt: "2026-01-01T00:00:00.000Z" },
      // The encrypted key column must never be selected or carried.
      llm_api_key_encrypted: "ENCRYPTED_SECRET",
    });

    const tpl = await createTemplateFromAgent("owner", "agent-1");
    expect(tpl).not.toBeNull();
    expect(tpl?.type).toBe("claude-code");
    expect(tpl?.name).toBe("My Builder");
    expect(tpl?.visibility).toBe("private");
    // Private template keeps the owner's context.
    expect(tpl?.context).toBe("secret internal notes");

    // The inserted row must not include the encrypted key under any field.
    expect(lastInsert).not.toBeNull();
    expect(JSON.stringify(lastInsert)).not.toContain("ENCRYPTED_SECRET");
    expect(lastInsert).not.toHaveProperty("llm_api_key_encrypted");
    expect(lastInsert?.owner_user_id).toBe("owner");
  });

  it("snapshots the box's installed skills into the template when running", async () => {
    tables.hivra_agents.rows.push({
      id: "agent-skills",
      user_id: "owner",
      type: "claude-code",
      name: "Skilled",
      status: "running",
      chat_url: "https://box.example",
      api_token: "tok",
    });
    mockSnapshot.mockResolvedValueOnce(["sec-1pw", "aliased"]);

    const tpl = await createTemplateFromAgent("owner", "agent-skills");
    expect(mockSnapshot).toHaveBeenCalledWith("https://box.example", "tok");
    expect(tpl?.skills).toEqual(["sec-1pw", "aliased"]);
    expect(lastInsert?.skills).toEqual(["sec-1pw", "aliased"]);
  });

  it("does not query the box (skills []) when the agent isn't running", async () => {
    tables.hivra_agents.rows.push({
      id: "agent-down",
      user_id: "owner",
      type: "claude-code",
      name: "Down",
      status: "provisioning",
      chat_url: "https://box.example",
    });
    const tpl = await createTemplateFromAgent("owner", "agent-down");
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(tpl?.skills).toEqual([]);
  });

  it("returns null when the agent isn't owned by the requesting user", async () => {
    tables.hivra_agents.rows.push({ id: "agent-2", user_id: "someone-else", type: "codex" });
    const tpl = await createTemplateFromAgent("owner", "agent-2");
    expect(tpl).toBeNull();
  });

  it("generates distinct slugs for two agents with the same name", async () => {
    tables.hivra_agents.rows.push(
      { id: "a1", user_id: "owner", type: "codex", name: "Same Name" },
      { id: "a2", user_id: "owner", type: "codex", name: "Same Name" },
    );
    const t1 = await createTemplateFromAgent("owner", "a1");
    const t2 = await createTemplateFromAgent("owner", "a2");
    expect(t1?.slug).toBeTruthy();
    expect(t2?.slug).toBeTruthy();
    expect(t1?.slug).not.toBe(t2?.slug);
  });
});

describe("setTemplateVisibility", () => {
  it("mints a share token on link/public and clears it on private", async () => {
    tables.agent_templates.rows.push({
      id: "t1",
      owner_user_id: "owner",
      slug: "t1",
      type: "codex",
      visibility: "private",
      share_token: null,
    });

    const linked = await setTemplateVisibility("owner", "t1", "link");
    expect(linked?.visibility).toBe("link");
    expect(linked?.share_token).toBeTruthy();
    const firstToken = linked?.share_token;

    // Going public keeps the same token (stable URL).
    const pub = await setTemplateVisibility("owner", "t1", "public");
    expect(pub?.visibility).toBe("public");
    expect(pub?.share_token).toBe(firstToken);

    // Going private revokes the link.
    const priv = await setTemplateVisibility("owner", "t1", "private");
    expect(priv?.visibility).toBe("private");
    expect(priv?.share_token).toBeNull();
  });

  it("refuses an invalid visibility and a non-owner", async () => {
    tables.agent_templates.rows.push({ id: "t2", owner_user_id: "owner", slug: "t2", type: "codex", visibility: "private", share_token: null });
    expect(await setTemplateVisibility("owner", "t2", "bogus")).toBeNull();
    expect(await setTemplateVisibility("intruder", "t2", "public")).toBeNull();
  });
});

describe("getTemplateForLaunch", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    owner_user_id: "owner",
    slug: "shared-one",
    type: "claude-code",
    name: "Shared",
    goal: "build",
    context: "owner private context",
    personality: "calm",
    emoji: "🤖",
    llm_config: null,
    skills: ["sec-1pw", "aliased"],
  };

  it("gives the owner the full identity including context and skills", async () => {
    tables.agent_templates.rows.push({ ...base, visibility: "public" });
    const identity = await getTemplateForLaunch(base.id, "owner");
    expect(identity?.context).toBe("owner private context");
    expect(identity?.type).toBe("claude-code");
    expect(identity?.skills).toEqual(["sec-1pw", "aliased"]);
  });

  it("strips context but CARRIES skills for a non-owner on a shared template", async () => {
    tables.agent_templates.rows.push({ ...base, visibility: "public" });
    const identity = await getTemplateForLaunch(base.id, "stranger");
    expect(identity).not.toBeNull();
    expect(identity?.context).toBeNull();
    expect(identity?.name).toBe("Shared");
    // Skill ids are non-sensitive — a fork from a shared template reproduces them.
    expect(identity?.skills).toEqual(["sec-1pw", "aliased"]);
  });

  it("404s (null) on a private template for a non-owner", async () => {
    tables.agent_templates.rows.push({ ...base, visibility: "private" });
    const identity = await getTemplateForLaunch(base.id, "stranger");
    expect(identity).toBeNull();
  });

  it("resolves by slug as well as id", async () => {
    tables.agent_templates.rows.push({ ...base, visibility: "link" });
    const identity = await getTemplateForLaunch("shared-one", "owner");
    expect(identity?.type).toBe("claude-code");
    expect(identity?.context).toBe("owner private context");
  });
});

describe("getPublicTemplateByShareToken", () => {
  it("returns a shared template by token with context always null", async () => {
    tables.agent_templates.rows.push({
      id: "tp",
      owner_user_id: "owner",
      slug: "tp",
      type: "codex",
      name: "Public One",
      goal: "automate",
      context: "should never leak",
      personality: "brisk",
      emoji: "⚙️",
      llm_config: null,
      skills: ["sec-1pw"],
      visibility: "public",
      share_token: "tok123",
    });
    const tpl = await getPublicTemplateByShareToken("tok123");
    expect(tpl?.name).toBe("Public One");
    expect(tpl?.context).toBeNull();
    expect(tpl?.skills).toEqual(["sec-1pw"]); // ids are non-sensitive — safe to share
    expect(JSON.stringify(tpl)).not.toContain("should never leak");
  });

  it("returns null for an unknown token", async () => {
    expect(await getPublicTemplateByShareToken("nope")).toBeNull();
  });
});

describe("listUserTemplates + deleteTemplate", () => {
  it("lists only the owner's templates and deletes an owned one", async () => {
    tables.agent_templates.rows.push(
      { id: "o1", owner_user_id: "owner", slug: "o1", type: "codex", visibility: "private", share_token: null, created_at: "2026-01-01" },
      { id: "x1", owner_user_id: "other", slug: "x1", type: "codex", visibility: "private", share_token: null, created_at: "2026-01-01" },
    );
    const mine = await listUserTemplates("owner");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("o1");

    // A non-owner can't delete.
    expect(await deleteTemplate("intruder", "o1")).toBe(false);
    // The owner can.
    expect(await deleteTemplate("owner", "o1")).toBe(true);
    expect(await listUserTemplates("owner")).toHaveLength(0);
  });
});
