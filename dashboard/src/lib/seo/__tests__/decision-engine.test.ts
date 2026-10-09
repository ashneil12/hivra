import {
  backlogFill,
  findDuplicateCandidate,
  significantTerms,
  computeWowMetrics,
  contentDecay,
  ctrAnomalies,
  ctrUpliftPotential,
  expectedCtrAtPosition,
  EXPECTED_CTR_BY_POSITION,
  inventoryRegressions,
  quickWins,
  rankActions,
  suppressActiveActions,
  type DecisionEngineInputs,
  type SeoGscDailyRow,
  type SeoPageInventoryRow,
  type SeoPageTitleRow,
  type SeoTargetRow,
} from "../decision-engine";

function gscRow(overrides: Partial<SeoGscDailyRow> = {}): SeoGscDailyRow {
  return {
    date: "2026-07-14",
    site: "https://hivra.cloud",
    page: "https://hivra.cloud/agents/claude-code",
    query: "claude code hosting",
    clicks: 0,
    impressions: 0,
    ctr: 0,
    position: 10,
    ...overrides,
  };
}

function targetRow(overrides: Partial<SeoTargetRow> = {}): SeoTargetRow {
  return {
    keyword: "claude code hosting",
    cluster: "claude-code",
    intent: "commercial",
    target_url: null,
    status: "open",
    priority: 80,
    ...overrides,
  };
}

function inventoryRow(overrides: Partial<SeoPageInventoryRow> = {}): SeoPageInventoryRow {
  return {
    url: "https://hivra.cloud/pricing",
    last_status: 200,
    canonical_ok: true,
    ...overrides,
  };
}

/** Emits 7 daily rows ending at `endDate` (inclusive), clicks split evenly. */
function weekOfRows(
  page: string,
  endDate: string,
  clicksPerDay: number,
  overrides: Partial<SeoGscDailyRow> = {},
): SeoGscDailyRow[] {
  const rows: SeoGscDailyRow[] = [];
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    rows.push(
      gscRow({
        date: d.toISOString().slice(0, 10),
        page,
        clicks: clicksPerDay,
        impressions: clicksPerDay * 10,
        ...overrides,
      }),
    );
  }
  return rows;
}

describe("expectedCtrAtPosition", () => {
  it("returns the curve value at exact positions", () => {
    expect(expectedCtrAtPosition(1)).toBe(EXPECTED_CTR_BY_POSITION[0]);
    expect(expectedCtrAtPosition(3)).toBe(EXPECTED_CTR_BY_POSITION[2]);
    expect(expectedCtrAtPosition(20)).toBe(EXPECTED_CTR_BY_POSITION[19]);
  });

  it("clamps positions below 1 to position 1", () => {
    expect(expectedCtrAtPosition(0)).toBe(EXPECTED_CTR_BY_POSITION[0]);
    expect(expectedCtrAtPosition(-3)).toBe(EXPECTED_CTR_BY_POSITION[0]);
  });

  it("clamps positions past the end of the curve to position 20", () => {
    expect(expectedCtrAtPosition(21)).toBe(EXPECTED_CTR_BY_POSITION[19]);
    expect(expectedCtrAtPosition(99)).toBe(EXPECTED_CTR_BY_POSITION[19]);
  });

  it("rounds fractional positions to the nearest whole position", () => {
    expect(expectedCtrAtPosition(5.4)).toBe(EXPECTED_CTR_BY_POSITION[4]);
    expect(expectedCtrAtPosition(5.6)).toBe(EXPECTED_CTR_BY_POSITION[5]);
  });

  it("the curve is monotonically non-increasing", () => {
    for (let i = 1; i < EXPECTED_CTR_BY_POSITION.length; i += 1) {
      expect(EXPECTED_CTR_BY_POSITION[i]).toBeLessThanOrEqual(EXPECTED_CTR_BY_POSITION[i - 1]);
    }
  });
});

describe("ctrUpliftPotential", () => {
  it("is zero at or above position 3", () => {
    expect(ctrUpliftPotential(1)).toBe(0);
    expect(ctrUpliftPotential(2)).toBe(0);
    expect(ctrUpliftPotential(3)).toBe(0);
  });

  it("grows as position worsens", () => {
    expect(ctrUpliftPotential(10)).toBeGreaterThan(ctrUpliftPotential(5));
    expect(ctrUpliftPotential(20)).toBeGreaterThan(ctrUpliftPotential(10));
  });
});

describe("quickWins", () => {
  it("flags a page with a qualifying query and scores it by impressions * uplift", () => {
    const rows = [
      gscRow({ page: "https://hivra.cloud/a", query: "q1", impressions: 100, position: 8 }),
    ];
    const actions = quickWins(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("optimize_page");
    expect(actions[0].target).toBe("https://hivra.cloud/a");
    expect(actions[0].score).toBeCloseTo(100 * ctrUpliftPotential(8), 2);
    expect(actions[0].rationale).toContain('"q1"');
  });

  it("excludes queries under 50 impressions over the window", () => {
    const rows = [gscRow({ impressions: 49, position: 8 })];
    expect(quickWins(rows)).toHaveLength(0);
  });

  it("excludes queries outside the position 5-20 band", () => {
    expect(quickWins([gscRow({ impressions: 200, position: 4 })])).toHaveLength(0);
    expect(quickWins([gscRow({ impressions: 200, position: 21 })])).toHaveLength(0);
    expect(quickWins([gscRow({ impressions: 200, position: 5 })])).toHaveLength(1);
    expect(quickWins([gscRow({ impressions: 200, position: 20 })])).toHaveLength(1);
  });

  it("aggregates a query across days using impression-weighted position", () => {
    // 100 imps at pos 4 + 100 imps at pos 8 → weighted avg pos 6 → qualifies.
    const rows = [
      gscRow({ date: "2026-07-13", impressions: 100, position: 4 }),
      gscRow({ date: "2026-07-14", impressions: 100, position: 8 }),
    ];
    const actions = quickWins(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].score).toBeCloseTo(200 * ctrUpliftPotential(6), 2);
  });

  it("groups multiple qualifying queries under one page action and sums scores", () => {
    const rows = [
      gscRow({ page: "https://hivra.cloud/a", query: "q1", impressions: 100, position: 8 }),
      gscRow({ page: "https://hivra.cloud/a", query: "q2", impressions: 60, position: 12 }),
    ];
    const actions = quickWins(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].score).toBeCloseTo(
      100 * ctrUpliftPotential(8) + 60 * ctrUpliftPotential(12),
      2,
    );
    expect(actions[0].rationale).toContain("2 quick-win queries");
    // Best query for the rationale is the highest-impression one.
    expect(actions[0].rationale).toContain('"q1"');
  });
});

describe("contentDecay", () => {
  const page = "https://hivra.cloud/blog/what-is-hermes-agent";

  it("flags a page whose trailing 7d clicks dropped >= 30% vs prior 7d", () => {
    const rows = [
      ...weekOfRows(page, "2026-07-07", 10), // prior week: 70 clicks
      ...weekOfRows(page, "2026-07-14", 4), // trailing week: 28 clicks (-60%)
    ];
    const actions = contentDecay(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("refresh_content");
    expect(actions[0].target).toBe(page);
    expect(actions[0].rationale).toContain("60%");
    expect(actions[0].rationale).toContain("70 → 28");
  });

  it("computes the drop against exact 7-day windows anchored on the newest date", () => {
    // A day 15 days before the anchor belongs to NEITHER window and must
    // not pollute the baseline.
    const rows = [
      gscRow({ date: "2026-06-29", page, clicks: 1000 }),
      ...weekOfRows(page, "2026-07-07", 10),
      ...weekOfRows(page, "2026-07-14", 4),
    ];
    const actions = contentDecay(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].rationale).toContain("70 → 28");
  });

  it("ignores pages under the 10-click baseline", () => {
    const rows = [
      ...weekOfRows(page, "2026-07-07", 1), // 7 clicks baseline
      ...weekOfRows(page, "2026-07-14", 0),
    ];
    expect(contentDecay(rows)).toHaveLength(0);
  });

  it("ignores drops under 30%", () => {
    const rows = [
      ...weekOfRows(page, "2026-07-07", 10), // 70
      ...weekOfRows(page, "2026-07-14", 8), // 56 (-20%)
    ];
    expect(contentDecay(rows)).toHaveLength(0);
  });

  it("flags exactly at the 30% threshold", () => {
    const rows = [
      ...weekOfRows(page, "2026-07-07", 10), // 70
      ...weekOfRows(page, "2026-07-14", 7), // 49 (-30%)
    ];
    expect(contentDecay(rows)).toHaveLength(1);
  });

  it("returns nothing for empty input", () => {
    expect(contentDecay([])).toHaveLength(0);
  });
});

describe("ctrAnomalies", () => {
  it("flags a top-5 query whose CTR is under half the expected curve", () => {
    // Position 2 expects 15%; half is 7.5%. 2/200 = 1% → anomaly.
    const rows = [
      gscRow({ impressions: 200, clicks: 2, position: 2 }),
    ];
    const actions = ctrAnomalies(rows);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("rewrite_meta");
    expect(actions[0].target).toBe("https://hivra.cloud/agents/claude-code");
    expect(actions[0].score).toBeCloseTo(200 * (0.15 - 0.01), 2);
  });

  it("does not flag CTR at or above half the expected value", () => {
    // Position 2 expects 15%; 16/200 = 8% ≥ 7.5% → fine.
    const rows = [gscRow({ impressions: 200, clicks: 16, position: 2 })];
    expect(ctrAnomalies(rows)).toHaveLength(0);
  });

  it("requires at least 100 impressions", () => {
    const rows = [gscRow({ impressions: 99, clicks: 0, position: 2 })];
    expect(ctrAnomalies(rows)).toHaveLength(0);
  });

  it("ignores positions worse than 5", () => {
    const rows = [gscRow({ impressions: 500, clicks: 0, position: 6 })];
    expect(ctrAnomalies(rows)).toHaveLength(0);
  });
});

describe("backlogFill", () => {
  it("emits create_content for open targets with no target_url", () => {
    const actions = backlogFill([targetRow({ keyword: "codex hosting", priority: 90 })], []);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("create_content");
    expect(actions[0].target).toBe("codex hosting");
    expect(actions[0].score).toBe(180);
    expect(actions[0].rationale).toContain("claude-code");
  });

  it("emits create_content when the planned URL is not live in inventory", () => {
    const targets = [targetRow({ target_url: "https://hivra.cloud/agents/codex" })];
    // Not in inventory at all:
    expect(backlogFill(targets, [])).toHaveLength(1);
    // In inventory but broken:
    expect(
      backlogFill(targets, [
        inventoryRow({ url: "https://hivra.cloud/agents/codex", last_status: 404 }),
      ]),
    ).toHaveLength(1);
  });

  it("skips open targets whose planned URL is live (200 or 301)", () => {
    const targets = [targetRow({ target_url: "https://hivra.cloud/agents/codex" })];
    expect(
      backlogFill(targets, [
        inventoryRow({ url: "https://hivra.cloud/agents/codex", last_status: 200 }),
      ]),
    ).toHaveLength(0);
    expect(
      backlogFill(targets, [
        inventoryRow({ url: "https://hivra.cloud/agents/codex", last_status: 301 }),
      ]),
    ).toHaveLength(0);
  });

  it("skips non-open targets", () => {
    expect(backlogFill([targetRow({ status: "live" })], [])).toHaveLength(0);
    expect(backlogFill([targetRow({ status: "done" })], [])).toHaveLength(0);
  });

  it("scores by priority", () => {
    const actions = backlogFill(
      [
        targetRow({ keyword: "a", priority: 90 }),
        targetRow({ keyword: "b", priority: 40 }),
      ],
      [],
    );
    const byKeyword = new Map(actions.map((a) => [a.target, a.score]));
    expect(byKeyword.get("a")).toBeGreaterThan(byKeyword.get("b") as number);
  });
});

describe("inventoryRegressions", () => {
  it("flags non-200/301 statuses with a near-top score", () => {
    const actions = inventoryRegressions([
      inventoryRow({ url: "https://hivra.cloud/broken", last_status: 404 }),
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("fix_page");
    expect(actions[0].score).toBe(950);
    expect(actions[0].rationale).toContain("status 404");
  });

  it("flags canonical mismatches on otherwise healthy pages", () => {
    const actions = inventoryRegressions([
      inventoryRow({ last_status: 200, canonical_ok: false }),
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0].score).toBe(900);
    expect(actions[0].rationale).toContain("canonical mismatch");
  });

  it("flags null status as a regression", () => {
    const actions = inventoryRegressions([inventoryRow({ last_status: null })]);
    expect(actions).toHaveLength(1);
    expect(actions[0].rationale).toContain("status unknown");
  });

  it("skips healthy pages (200/301 with canonical_ok)", () => {
    expect(
      inventoryRegressions([
        inventoryRow({ last_status: 200 }),
        inventoryRow({ url: "https://hivra.cloud/moved", last_status: 301 }),
      ]),
    ).toHaveLength(0);
  });

  it("mentions both problems when status and canonical are both bad", () => {
    const actions = inventoryRegressions([
      inventoryRow({ last_status: 500, canonical_ok: false }),
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0].score).toBe(950);
    expect(actions[0].rationale).toContain("status 500");
    expect(actions[0].rationale).toContain("canonical mismatch");
  });
});

describe("rankActions", () => {
  it("is safe on completely empty inputs", () => {
    expect(rankActions({ gscDaily: [], targets: [], pageInventory: [] })).toEqual([]);
  });

  it("yields only backlogFill actions at launch state (empty GSC + inventory, open targets)", () => {
    const inputs: DecisionEngineInputs = {
      gscDaily: [],
      pageInventory: [],
      targets: [
        targetRow({ keyword: "claude code hosting", priority: 90 }),
        targetRow({ keyword: "codex hosting", priority: 85 }),
      ],
    };
    const actions = rankActions(inputs);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.action_type === "create_content")).toBe(true);
    expect(actions[0].target).toBe("claude code hosting");
  });

  it("sorts by score descending", () => {
    const inputs: DecisionEngineInputs = {
      gscDaily: [gscRow({ page: "https://hivra.cloud/a", impressions: 100, position: 10 })],
      pageInventory: [inventoryRow({ url: "https://hivra.cloud/broken", last_status: 500 })],
      targets: [targetRow({ keyword: "kw", priority: 40 })],
    };
    const actions = rankActions(inputs);
    const scores = actions.map((a) => a.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(actions[0].action_type).toBe("fix_page");
  });

  it("breaks score ties deterministically by target", () => {
    const inputs: DecisionEngineInputs = {
      gscDaily: [],
      targets: [],
      pageInventory: [
        inventoryRow({ url: "https://hivra.cloud/z", last_status: 404 }),
        inventoryRow({ url: "https://hivra.cloud/a", last_status: 500 }),
        inventoryRow({ url: "https://hivra.cloud/m", last_status: 410 }),
      ],
    };
    const targets = rankActions(inputs).map((a) => a.target);
    expect(targets).toEqual([
      "https://hivra.cloud/a",
      "https://hivra.cloud/m",
      "https://hivra.cloud/z",
    ]);
  });

  it("is deterministic across calls and input ordering", () => {
    const gsc = [
      gscRow({ page: "https://hivra.cloud/a", query: "q1", impressions: 100, position: 8 }),
      gscRow({ page: "https://hivra.cloud/b", query: "q2", impressions: 300, clicks: 1, position: 2 }),
    ];
    const targets = [
      targetRow({ keyword: "kw1", priority: 70 }),
      targetRow({ keyword: "kw2", priority: 60 }),
    ];
    const inventory = [inventoryRow({ url: "https://hivra.cloud/broken", last_status: 404 })];

    const a = rankActions({ gscDaily: gsc, targets, pageInventory: inventory });
    const b = rankActions({
      gscDaily: [...gsc].reverse(),
      targets: [...targets].reverse(),
      pageInventory: [...inventory],
    });
    expect(a).toEqual(b);
    expect(a).toEqual(rankActions({ gscDaily: gsc, targets, pageInventory: inventory }));
  });

  it("caps the list at 50 actions", () => {
    const targets: SeoTargetRow[] = [];
    for (let i = 0; i < 60; i += 1) {
      targets.push(targetRow({ keyword: `kw-${String(i).padStart(2, "0")}`, priority: 50 }));
    }
    expect(rankActions({ gscDaily: [], targets, pageInventory: [] })).toHaveLength(50);
  });
});

describe("computeWowMetrics", () => {
  it("returns zeros with null change on empty input", () => {
    const metrics = computeWowMetrics([]);
    expect(metrics.clicks_wow).toEqual({ current: 0, previous: 0, change_pct: null });
    expect(metrics.impressions_wow.change_pct).toBeNull();
  });

  it("computes trailing vs prior 7-day totals anchored on the newest date", () => {
    const page = "https://hivra.cloud/a";
    const rows = [
      ...weekOfRows(page, "2026-07-07", 10), // prior: 70 clicks, 700 imps
      ...weekOfRows(page, "2026-07-14", 5), // trailing: 35 clicks, 350 imps
    ];
    const metrics = computeWowMetrics(rows);
    expect(metrics.clicks_wow).toEqual({ current: 35, previous: 70, change_pct: -50 });
    expect(metrics.impressions_wow).toEqual({ current: 350, previous: 700, change_pct: -50 });
  });

  it("excludes brand queries (hivra/hermes, case-insensitive) from nonbrand impressions", () => {
    const page = "https://hivra.cloud/a";
    const rows = [
      ...weekOfRows(page, "2026-07-14", 5, { query: "claude code hosting" }), // 350 imps
      ...weekOfRows(page, "2026-07-14", 5, { query: "Hivra pricing" }),
      ...weekOfRows(page, "2026-07-14", 5, { query: "HERMES agent hosting" }),
    ];
    const metrics = computeWowMetrics(rows);
    expect(metrics.impressions_wow.current).toBe(1050);
    expect(metrics.nonbrand_impressions_wow.current).toBe(350);
  });

  it("reports null change_pct when the prior week is zero", () => {
    const rows = weekOfRows("https://hivra.cloud/a", "2026-07-14", 5);
    const metrics = computeWowMetrics(rows);
    expect(metrics.clicks_wow.change_pct).toBeNull();
    expect(metrics.clicks_wow.current).toBe(35);
    expect(metrics.clicks_wow.previous).toBe(0);
  });
});

describe("backlogFill URL-shape normalization", () => {
  it("treats an absolute inventory URL as live for a path-shaped target", () => {
    const targets = [
      {
        keyword: "claude code hosting",
        cluster: "claude-code",
        intent: "commercial",
        target_url: "/agents/claude-code",
        status: "open",
        priority: 90,
      },
      {
        keyword: "codex hosting",
        cluster: "codex",
        intent: "commercial",
        target_url: "/agents/codex",
        status: "open",
        priority: 85,
      },
    ] as SeoTargetRow[];
    const inventory = [
      { url: "https://hivra.cloud/agents/claude-code", last_status: 200, canonical_ok: true },
    ] as SeoPageInventoryRow[];

    const actions = backlogFill(targets, inventory);
    const keywords = actions.map((a) => a.target);
    expect(keywords).not.toContain("claude code hosting");
    expect(keywords).toContain("codex hosting");
  });

  it("normalizes trailing slashes on both sides", () => {
    const targets = [
      {
        keyword: "pricing page",
        cluster: "category",
        intent: "commercial",
        target_url: "/pricing/",
        status: "open",
        priority: 50,
      },
    ] as SeoTargetRow[];
    const inventory = [
      { url: "https://hivra.cloud/pricing", last_status: 200, canonical_ok: true },
    ] as SeoPageInventoryRow[];

    expect(backlogFill(targets, inventory)).toHaveLength(0);
  });
});

describe("backlogFill phantom-gap detection", () => {
  // The live backlog and page titles as they stood on 2026-07-18, the run
  // that found the bug. "aeon agent hosting" had been the brief's #1 action
  // for days while /agents/aeon was live, sitemapped, and titled for that
  // exact query, because nobody back-linked its seo_targets row.
  const LIVE_PAGES: SeoPageTitleRow[] = [
    { path: "/agents/aeon", title: "Aeon Agent Hosting: Runs on Your GitHub | Hivra" },
    { path: "/agents/agent-zero", title: "Agent Zero Hosting: Deploy It in the Cloud for $9.99/mo" },
    { path: "/agents/claude-code", title: "Run Claude Code in the Cloud 24/7 | Hivra" },
    { path: "/agents/codex", title: "Codex Hosting: Run OpenAI Codex 24/7 in the Cloud" },
    { path: "/agents/openclaw", title: "OpenClaw Hosting: Always-On Managed Box for $9.99/mo" },
    {
      path: "/blog/run-codex-24-7-in-the-cloud",
      title: "How to run Codex 24/7 in the cloud (Codex CLI hosting explained)",
    },
    {
      path: "/blog/run-ai-agents-24-7",
      title: "How to run AI agents 24/7: infrastructure, recovery, and real cost (2026)",
    },
    {
      path: "/blog/how-to-self-host-openclaw",
      title: "How to self-host OpenClaw: complete setup guide (2026)",
    },
    {
      path: "/blog/agent-zero-vs-openclaw-hosting",
      title: "Agent Zero vs OpenClaw hosting: requirements, costs, and which to run",
    },
  ];
  const liveInventory = LIVE_PAGES.map((p) =>
    inventoryRow({ url: `https://hivra.cloud${p.path}`, last_status: 200 }),
  );

  it("flags the real phantom without dropping it", () => {
    const actions = backlogFill(
      [targetRow({ keyword: "aeon agent hosting", cluster: "aeon", priority: 75 })],
      liveInventory,
      LIVE_PAGES,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].possible_existing_url).toBe("/agents/aeon");
    expect(actions[0].rationale).toContain("may already serve this keyword");
    // Damped, not removed: 75 * 2 * 0.35.
    expect(actions[0].score).toBe(52.5);
  });

  it("leaves every genuine gap in the same backlog unflagged", () => {
    // These are real open targets. Each shares vocabulary with a live page
    // but asks something that page does not answer, so a warning here would
    // bury real work.
    const genuineGaps = [
      { keyword: "openclaw broken after update", cluster: "openclaw" },
      { keyword: "is it safe to leave an ai agent running unattended", cluster: "category" },
      { keyword: "run claude code on a raspberry pi", cluster: "claude-code" },
      { keyword: "do you need a gpu to run an ai agent", cluster: "category" },
      { keyword: "control claude code from telegram", cluster: "claude-code" },
      { keyword: "use codex cli from phone", cluster: "codex" },
      { keyword: "agent zero vs autogpt", cluster: "agent-zero" },
    ];
    const actions = backlogFill(
      genuineGaps.map((g) => targetRow(g)),
      liveInventory,
      LIVE_PAGES,
    );
    expect(actions).toHaveLength(genuineGaps.length);
    expect(actions.filter((a) => a.possible_existing_url)).toEqual([]);
  });

  it("flags a borderline overlap at the threshold, for a human to adjudicate", () => {
    // "agent zero docker requirements" matches the comparison article on
    // agent/zero/requirement (75%) but NOT on docker, which is the whole
    // question. This is the matcher working as intended: it cannot tell a
    // real duplicate from an adjacent one, so it damps and defers rather
    // than deciding. The 2026-07-18 human read left this target open.
    const actions = backlogFill(
      [targetRow({ keyword: "agent zero docker requirements", cluster: "agent-zero", priority: 58 })],
      liveInventory,
      LIVE_PAGES,
    );
    expect(actions[0].possible_existing_url).toBe("/blog/agent-zero-vs-openclaw-hosting");
    expect(actions[0].rationale).toContain("Confirm it does not before writing");
  });

  it("ranks a flagged duplicate below the genuine gaps it used to outrank", () => {
    const actions = backlogFill(
      [
        targetRow({ keyword: "aeon agent hosting", cluster: "aeon", priority: 75 }),
        targetRow({ keyword: "openclaw broken after update", cluster: "openclaw", priority: 71 }),
      ],
      liveInventory,
      LIVE_PAGES,
    );
    const aeon = actions.find((a) => a.target === "aeon agent hosting")!;
    const openclaw = actions.find((a) => a.target === "openclaw broken after update")!;
    expect(aeon.score).toBeLessThan(openclaw.score);
  });

  it("does not treat a page the inventory says is broken as a duplicate", () => {
    // Same title index, but the page 404s: that is a real gap, not a duplicate.
    const actions = backlogFill(
      [targetRow({ keyword: "aeon agent hosting", cluster: "aeon", priority: 75 })],
      [inventoryRow({ url: "https://hivra.cloud/agents/aeon", last_status: 404 })],
      LIVE_PAGES,
    );
    expect(actions[0].possible_existing_url).toBeUndefined();
    expect(actions[0].score).toBe(150);
  });

  it("still flags a page that shipped since the last inventory sweep", () => {
    // The regression this guard was built for. The inventory sweep runs
    // Mondays; /blog/agent-zero-vs-openclaw-hosting shipped 2026-07-16 and was
    // absent from a crawl last run 07-15. Gating on inventory presence made
    // the guard blind for the entire window where phantoms are actually made.
    const actions = backlogFill(
      [targetRow({ keyword: "agent zero docker requirements", cluster: "agent-zero", priority: 58 })],
      [], // inventory has never seen any of these pages
      LIVE_PAGES,
    );
    expect(actions[0].possible_existing_url).toBe("/blog/agent-zero-vs-openclaw-hosting");
  });

  it("stays inert when no title index is supplied", () => {
    const actions = backlogFill(
      [targetRow({ keyword: "aeon agent hosting", cluster: "aeon", priority: 75 })],
      liveInventory,
    );
    expect(actions[0].possible_existing_url).toBeUndefined();
    expect(actions[0].score).toBe(150);
  });

  it("never flags a target that already names its own planned URL", () => {
    // A filled-in target_url means someone planned the page; the fact that it
    // is not live yet is the point of the action, not a duplicate signal.
    const actions = backlogFill(
      [targetRow({ keyword: "aeon agent hosting", target_url: "/agents/aeon-new" })],
      liveInventory,
      LIVE_PAGES,
    );
    expect(actions[0].possible_existing_url).toBeUndefined();
  });
});

describe("findDuplicateCandidate", () => {
  it("matches across singular/plural and -ing forms", () => {
    // "running agents" and "run agent" must reduce to the same terms, or a
    // title saying "run" would not recognize a keyword saying "running".
    expect(significantTerms("running agents")).toEqual(["run", "agent"]);
    expect(significantTerms("run agent")).toEqual(["run", "agent"]);
    expect(significantTerms("boxes")).toEqual(["box"]);
    // Known miss: silent-e forms are not reconciled, so the matcher stays
    // advisory. "closing" reduces to "clos" and "close" stays "close".
    expect(significantTerms("closing")).not.toEqual(significantTerms("close"));
  });

  it("returns the strongest match and breaks ties deterministically", () => {
    const pages: SeoPageTitleRow[] = [
      { path: "/b-page", title: "Codex Hosting Guide" },
      { path: "/a-page", title: "Codex Hosting Guide" },
    ];
    expect(findDuplicateCandidate("codex hosting guide", pages)?.path).toBe("/a-page");
  });

  it("ignores a keyword with no significant terms", () => {
    expect(findDuplicateCandidate("how to", [{ path: "/x", title: "How To" }])).toBeNull();
  });
});

describe("suppressActiveActions", () => {
  const ranked = [
    {
      action_type: "create_content" as const,
      target: "run claude code on a raspberry pi",
      score: 136,
      rationale: "open target",
    },
    {
      action_type: "optimize_page" as const,
      target: "https://hivra.cloud/",
      score: 124,
      rationale: "quick win",
    },
  ];

  it.each(["proposed", "pr_open", "merged", "live"])(
    "removes an exact action already in %s state",
    (status) => {
      expect(
        suppressActiveActions(ranked, [
          {
            action_type: "create_content",
            target: "run claude code on a raspberry pi",
            status,
          },
        ]),
      ).toEqual([ranked[1]]);
    },
  );

  it("does not suppress completed or merely similar work", () => {
    expect(
      suppressActiveActions(ranked, [
        {
          action_type: "create_content",
          target: "run claude code on a raspberry pi",
          status: "measured",
        },
        {
          action_type: "rewrite_meta",
          target: "https://hivra.cloud/",
          status: "pr_open",
        },
      ]),
    ).toEqual(ranked);
  });
});
