import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getGoal, deriveIdentity, GOALS, DEFAULT_GOAL_ID } from "@/lib/hivra/agent-identity";
import {
  agentReadsHivraIdentity,
  buildBootstrapContent,
  buildGuestScript,
  BOOTSTRAP_START,
  BOOTSTRAP_END,
  MAX_SHARED_MEMORY_FOLD_LEN,
} from "@/lib/hivra/agent-bootstrap";
import { MAX_CONTEXT_LEN } from "@/lib/hivra/agent-limits";

describe("agent-identity", () => {
  it("resolves a known goal and falls back to the default for unknown/empty", () => {
    expect(getGoal("build").id).toBe("build");
    expect(getGoal("not-a-goal").id).toBe(DEFAULT_GOAL_ID);
    expect(getGoal(null).id).toBe(DEFAULT_GOAL_ID);
    expect(getGoal(undefined).id).toBe(DEFAULT_GOAL_ID);
  });

  it("derives a complete identity from the goal (default-with-veto)", () => {
    const g = getGoal("research");
    const derived = deriveIdentity("research");
    // pure goal default
    expect(derived).toEqual({ name: g.suggestedName, emoji: g.emoji, personality: g.personality });
  });

  it("lets explicit overrides win, but ignores blank overrides", () => {
    const g = getGoal("build");
    const derived = deriveIdentity("build", { name: "Bolt", emoji: "  ", personality: "" });
    expect(derived.name).toBe("Bolt"); // override wins
    expect(derived.emoji).toBe(g.emoji); // blank → goal default
    expect(derived.personality).toBe(g.personality); // blank → goal default
  });

  it("every goal ships three concrete starters and an emoji", () => {
    for (const g of GOALS) {
      expect(g.starters).toHaveLength(3);
      expect(g.emoji.length).toBeGreaterThan(0);
      expect(g.suggestedName.length).toBeGreaterThan(0);
    }
  });
});

describe("buildBootstrapContent", () => {
  const agent = {
    id: "a1",
    name: "Atlas",
    type: "claude-code",
    goal: "grow",
    context: "I run a B2B SaaS for dentists.",
    personality: "strategic and candid",
    emoji: "📈",
  };

  it("puts the identity into SOUL.md", () => {
    const { soul } = buildBootstrapContent(agent);
    expect(soul).toContain("Atlas");
    expect(soul).toContain("📈");
    expect(soul).toContain("strategic and candid");
    expect(soul).toContain("Understand first, plan second, execute third");
    expect(soul).toContain("~/USER.md");
  });

  it("puts the goal, context, and starters into USER.md", () => {
    const { user } = buildBootstrapContent(agent);
    expect(user).toContain("Grow a business");
    expect(user).toContain("I run a B2B SaaS for dentists.");
    // starters from the catalog goal
    for (const s of getGoal("grow").starters) expect(user).toContain(s);
  });

  it("wraps the first-conversation prompt in idempotency markers", () => {
    const { promptBlock } = buildBootstrapContent(agent);
    expect(promptBlock).toContain(BOOTSTRAP_START);
    expect(promptBlock).toContain(BOOTSTRAP_END);
    expect(promptBlock).toContain("first useful outcome");
    expect(promptBlock).toContain("Don't interrogate");
    expect(promptBlock).toContain("Atlas");
    // exactly one block (so re-seeding's strip+append stays clean)
    expect(promptBlock.match(new RegExp(BOOTSTRAP_START, "g"))).toHaveLength(1);
    expect(promptBlock.match(new RegExp(BOOTSTRAP_END, "g"))).toHaveLength(1);
  });

  // ATT-08/ATT-09 regression: every non-Codex agent used to be told it can
  // "drive a real browser" even with browser automation off, and Codex was told
  // it has no browser even when launched with one. Browser automation is a
  // per-computer Manage toggle with no stored flag, and this seed runs once, so
  // the claim must be conditional for every type that ships the browser stack.
  it("states the browser conditionally for agent types that ship one (Claude Code and Codex alike)", () => {
    const conditional = "drive a real browser when browser automation is on in Manage";
    for (const type of ["claude-code", "codex"]) {
      const { soul, promptBlock } = buildBootstrapContent({ id: type, name: "Forge", type, goal: "build" });
      expect(soul).toContain(`- **You can:** write and run code, use a full terminal, and ${conditional}.`);
      expect(promptBlock).toContain(`You can write and run code, use a full terminal, and ${conditional}.`);
      // Never the old unconditional claim.
      expect(soul).not.toContain("drive a real browser,");
      expect(promptBlock).not.toContain("drive a real browser,");
    }
  });

  it("never claims a browser for agent types without the browser stack", () => {
    for (const type of ["hermes", "aeon", null]) {
      const { soul, promptBlock } = buildBootstrapContent({ id: String(type), name: "Forge", type, goal: "build" });
      expect(soul).toContain("- **You can:** write and run code, and use a full terminal.");
      expect(soul).not.toContain("browser");
      expect(promptBlock).not.toContain("browser");
    }
  });

  it("degrades gracefully with no onboarding (identity from name alone)", () => {
    const { soul, user, promptBlock } = buildBootstrapContent({ id: "a2", name: "Helper" });
    expect(soul).toContain("Helper");
    // default goal applied
    expect(user).toContain(getGoal(null).label);
    expect(user).toContain("none provided");
    expect(promptBlock).toContain(BOOTSTRAP_START);
  });

  it("caps over-long context", () => {
    const huge = "x".repeat(MAX_CONTEXT_LEN + 500);
    const { user } = buildBootstrapContent({ id: "a3", name: "Cap", context: huge });
    const captured = user.match(/x+/)?.[0] ?? "";
    expect(captured.length).toBeLessThanOrEqual(MAX_CONTEXT_LEN);
  });

  it("folds account shared memory into USER.md only when non-empty (Wave 5.1)", () => {
    // Present → section + the verbatim blob land in USER.md.
    const withMem = buildBootstrapContent({ ...agent, sharedMemory: "I bill in EUR. Be terse." });
    expect(withMem.user).toContain("## Shared account memory");
    expect(withMem.user).toContain("I bill in EUR. Be terse.");

    // Absent (undefined / "" / whitespace) → no section at all.
    expect(buildBootstrapContent(agent).user).not.toContain("## Shared account memory");
    expect(buildBootstrapContent({ ...agent, sharedMemory: "" }).user).not.toContain("## Shared account memory");
    expect(buildBootstrapContent({ ...agent, sharedMemory: "   " }).user).not.toContain("## Shared account memory");
  });

  it("clamps over-long shared memory in the fold", () => {
    const huge = "y".repeat(MAX_SHARED_MEMORY_FOLD_LEN + 500);
    const { user } = buildBootstrapContent({ ...agent, sharedMemory: huge });
    const captured = user.match(/y+/)?.[0] ?? "";
    expect(captured.length).toBeLessThanOrEqual(MAX_SHARED_MEMORY_FOLD_LEN);
  });
});

describe("buildBootstrapContent — persona souls (paioclaw-riplist upgrade)", () => {
  const base = {
    id: "p1",
    name: "Bea",
    type: "claude-code",
    goal: "assist",
    context: "I run a small agency.",
    personality: "a sharp reliable assistant",
    emoji: "🤖",
  };

  it("seeds SOUL.md with the FULL authored soul prompt when a known soulPromptId is chosen", () => {
    const { soul } = buildBootstrapContent({ ...base, soulPromptId: "bea" });
    // The full persona soul replaces the generic template entirely: the generic
    // template's signature line must be absent, and the soul must be long.
    expect(soul).not.toContain("# SOUL.md — 🤖 Bea");
    expect(soul.length).toBeGreaterThan(2000);
    // USER.md + the prompt block still use the derived identity (unchanged lane).
    const full = buildBootstrapContent({ ...base, soulPromptId: "bea" });
    expect(full.user).toContain("I run a small agency.");
    expect(full.promptBlock).toContain(BOOTSTRAP_START);
  });

  it("falls back to the GENERIC template for an unknown / missing soulPromptId (zero-regression)", () => {
    const generic = buildBootstrapContent(base); // no soulPromptId at all
    const unknown = buildBootstrapContent({ ...base, soulPromptId: "not-a-real-soul" });
    const blank = buildBootstrapContent({ ...base, soulPromptId: "" });
    const nul = buildBootstrapContent({ ...base, soulPromptId: null });
    for (const c of [generic, unknown, blank, nul]) {
      expect(c.soul).toContain("# SOUL.md — 🤖 Bea");
      expect(c.soul).toContain("Understand first, plan second, execute third");
    }
    // The unknown/blank/null variants are byte-identical to the no-id generic path.
    expect(unknown.soul).toBe(generic.soul);
    expect(blank.soul).toBe(generic.soul);
    expect(nul.soul).toBe(generic.soul);
  });

  it("base64-wraps the full soul so no soul markdown reaches the shell", () => {
    const content = buildBootstrapContent({ ...base, soulPromptId: "sloane" });
    const script = buildGuestScript(content);
    // A distinctive header line from the full prompt must NOT appear verbatim.
    expect(script).toContain("base64 -d");
    expect(script).not.toContain(content.soul.slice(0, 40));
  });
});

describe("buildGuestScript", () => {
  const content = buildBootstrapContent({ id: "a1", name: "Atlas", goal: "grow" });
  const script = buildGuestScript(content);

  it("never leaks raw markdown into the shell (base64-encoded payloads)", () => {
    // The human-readable identity text must NOT appear verbatim in the script —
    // it travels base64-encoded, so no markdown/quoting reaches a shell.
    expect(script).not.toContain("You are **Atlas**");
    expect(script).toContain("base64 -d");
    expect(script).toContain("$BUX/SOUL.md");
    expect(script).toContain("$BUX/USER.md");
  });

  it("appends the block idempotently via marker-stripping awk", () => {
    expect(script).toContain("system-prompt.md");
    expect(script).toContain(BOOTSTRAP_START);
    expect(script).toContain(BOOTSTRAP_END);
    expect(script).toContain("HIVRA_SEED_OK");
    expect(script).toContain("awk");
  });
});

describe("identity seed per runtime (ATT-14)", () => {
  const content = buildBootstrapContent({ id: "a2", name: "Claw", type: "openclaw" });
  const llm = { provider: "venice" as const, baseUrl: "https://api.venice.ai/api/v1", apiKey: "vk-test-000000", model: "venice-uncensored" };

  it("writes identity files only for runtimes that read them", () => {
    expect(agentReadsHivraIdentity("claude-code")).toBe(true);
    expect(agentReadsHivraIdentity("codex")).toBe(true);
    for (const type of ["openclaw", "aeon", "agent-zero", "deepseek-harness", "linux-desktop", "not-a-runtime", null]) {
      expect(agentReadsHivraIdentity(type)).toBe(false);
    }
  });

  it("gives a dashboard runtime only its model settings, never SOUL.md or USER.md", () => {
    const script = buildGuestScript(content, llm, { identity: false });
    expect(script).not.toContain("SOUL.md");
    expect(script).not.toContain("USER.md");
    expect(script).not.toContain("system-prompt.md");
    expect(script).toContain("llm-provider.json");
    expect(script).toContain("HIVRA_SEED_OK");
  });

  it("keeps the full identity seed for Claude Code and Codex by default", () => {
    const script = buildGuestScript(content, llm);
    expect(script).toContain("$BUX/SOUL.md");
    expect(script).toContain("system-prompt.md");
  });
});

describe("hivra_agent_bootstrap migration", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "supabase", "migrations", "20260606120000_hivra_agent_bootstrap.sql"),
    "utf8",
  );

  it("adds the onboarding + identity columns, idempotently", () => {
    for (const col of ["goal", "context", "personality", "emoji", "bootstrapped_at"]) {
      expect(sql).toContain(`add column if not exists ${col}`);
    }
  });
});

describe("hivra_agents_soul_prompt_id migration (persona souls)", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "supabase", "migrations", "20260620120000_hivra_agents_soul_prompt_id.sql"),
    "utf8",
  );

  it("adds the soul_prompt_id column idempotently", () => {
    expect(sql).toContain("add column if not exists soul_prompt_id text");
  });
});
