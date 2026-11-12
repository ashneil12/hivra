import {
  AGENT_PICKER_FACTS,
  AGENT_PICKER_KEYS,
  AGENT_PROFILES,
  EMPTY_ANSWERS,
  HERMES_VS_OPENCLAW_ROWS,
  QUESTIONS,
  QUESTION_KEYS,
  TIE_BREAK_ORDER,
  answeredCount,
  availableAgents,
  isComplete,
  parseAgentPickerParams,
  rankAgents,
  reasonsFor,
  recommend,
  serializeAgentPickerParams,
  startHrefFor,
  summaryText,
  type PickerAnswers,
} from "../agent-picker";
import { AGENT_PICKER_ENTRY, EXAMPLE_ANSWERS } from "../agent-picker-entry";
import { findBannedClaims } from "../../copy-rules";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { agentDeployHref, getAgentSeoEntry, unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";

const A = (over: Partial<PickerAnswers>): PickerAnswers => ({
  job: "assistant",
  where: "telegram",
  focus: "everyday",
  hands: "some",
  uptime: "always",
  sub: "neither",
  ...over,
});

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe("agents in the picker", () => {
  it("are exactly the agents Hivra offers with a public start link", () => {
    expect(availableAgents()).toEqual([...AGENT_PICKER_KEYS]);
    for (const key of AGENT_PICKER_KEYS) {
      expect(getAgent(AGENT_PROFILES[key].slug)?.available).toBe(true);
      expect(getAgent(AGENT_PROFILES[key].slug)?.name).toBe(AGENT_PROFILES[key].name);
      expect(getAgentSeoEntry(AGENT_PROFILES[key].slug)).toBeDefined();
    }
  });

  it("starts each agent with its sign-up agentType, Hermes being general", () => {
    expect(startHrefFor("hermes")).toBe(`${PUBLIC_START_HREF}?agentType=general`);
    expect(startHrefFor("openclaw")).toBe(`${PUBLIC_START_HREF}?agentType=openclaw`);
    expect(startHrefFor("claude-code")).toBe(agentDeployHref(getAgentSeoEntry("claude-code")!));
    expect(startHrefFor("aeon")).toBe(`${PUBLIC_START_HREF}?agentType=aeon`);
  });

  it("has a weight for every agent on every answer, within 0 to 3", () => {
    for (const q of QUESTIONS) {
      for (const a of q.answers) {
        expect(a.weights).toHaveLength(AGENT_PICKER_KEYS.length);
        for (const w of a.weights) expect(w >= 0 && w <= 3 && Number.isInteger(w)).toBe(true);
      }
    }
  });

  it("gives a reason wherever an answer weighs 2 or more for an agent, and only there", () => {
    for (const q of QUESTIONS) {
      for (const a of q.answers) {
        AGENT_PICKER_KEYS.forEach((agent, i) => {
          const has = Boolean(a.why[agent]);
          if (a.value === "some") return;
          expect({ q: q.key, a: a.value, agent, has }).toEqual({ q: q.key, a: a.value, agent, has: a.weights[i] >= 2 });
        });
      }
    }
  });
});

describe("recommend", () => {
  it("returns null until all six are answered", () => {
    expect(recommend(EMPTY_ANSWERS)).toBeNull();
    expect(recommend({ ...A({}), sub: "" })).toBeNull();
    expect(recommend(A({ where: "fax" }))).toBeNull();
    expect(answeredCount(A({ where: "fax" }))).toBe(5);
    expect(isComplete(A({}))).toBe(true);
  });

  it("is deterministic", () => {
    const first = recommend(A({}));
    for (let i = 0; i < 5; i++) expect(recommend(A({}))).toEqual(first);
  });

  it("sends a coder who pays for Claude to Claude Code, with Codex next", () => {
    const r = recommend(EXAMPLE_ANSWERS.coder)!;
    expect(r.top.agent).toBe("claude-code");
    expect(r.runnerUp?.agent).toBe("codex");
    expect(r.tied).toBe(false);
  });

  it("sends a coder who pays for ChatGPT to Codex", () => {
    expect(recommend(A({ job: "project", where: "terminal", focus: "code", hands: "minimal", uptime: "present", sub: "chatgpt" }))!.top.agent).toBe("codex");
  });

  it("sends scheduled work with no machine to Aeon", () => {
    const r = recommend(EXAMPLE_ANSWERS.scheduled)!;
    expect(r.top.agent).toBe("aeon");
    expect(r.reasons.some((x) => /GitHub/.test(x.text))).toBe(true);
  });

  it("sends a goal worked from a web page with no subscription to Agent Zero", () => {
    expect(recommend(A({ job: "project", where: "web", focus: "mixed", hands: "minimal", uptime: "away", sub: "neither" }))!.top.agent).toBe("agent-zero");
  });

  it("puts Discord assistants on Hermes or OpenClaw", () => {
    const r = recommend(A({ where: "discord" }))!;
    expect([r.top.agent, r.runnerUp?.agent].sort()).toEqual(["hermes", "openclaw"]);
  });

  it("lets a hands-on chat user tip it to OpenClaw", () => {
    expect(recommend(A({ hands: "tinker", where: "web" }))!.top.agent).toBe("openclaw");
  });

  it("never lets Claude Code or Codex win a no-code, always-on, chat-app question", () => {
    const r = recommend(A({}))!;
    expect(["claude-code", "codex"]).not.toContain(r.top.agent);
  });

  it("names exactly three reasons for the top pick, each tied to an answer it gave", () => {
    const r = recommend(A({}))!;
    expect(r.reasons).toHaveLength(3);
    expect(new Set(r.reasons.map((x) => x.question)).size).toBe(3);
    for (const reason of r.reasons) expect(reason.text.length).toBeGreaterThan(20);
  });

  it("ranks reasons by weight, then by question order", () => {
    const reasons = reasonsFor(A({ where: "telegram", job: "assistant" }), "openclaw");
    const weights = reasons.map((x) => x.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    // hands "some" has no reasons at all, so a question without text is simply skipped.
    expect(reasons.every((x) => x.question !== "hands")).toBe(true);
  });

  it("reports a maximum score from the best weight on each answer", () => {
    expect(recommend(A({}))!.maxScore).toBe(3 + 3 + 3 + 2 + 3 + 2);
  });
});

describe("ties", () => {
  it("flags a tie and breaks it by the fixed order", () => {
    const r = recommend(EXAMPLE_ANSWERS.chat)!;
    expect(r.ranking[0].score).toBe(r.ranking[1].score);
    expect(r.tied).toBe(true);
    expect(r.top.agent).toBe("hermes");
    expect(r.runnerUp?.agent).toBe("openclaw");
  });

  it("breaks an equal score by strong matches before the fixed order", () => {
    // Aeon and Agent Zero both score 10 here. Agent Zero is earlier in the fixed order, but Aeon has four
    // strong matches to its three, so Aeon is listed first.
    const answers = A({ job: "assistant", where: "web", focus: "code", hands: "some", uptime: "away", sub: "claude" });
    const [x, y] = rankAgents(answers).filter((r) => r.agent === "aeon" || r.agent === "agent-zero");
    expect(x.score).toBe(y.score);
    expect([x.agent, x.strongMatches, y.agent, y.strongMatches]).toEqual(["aeon", 4, "agent-zero", 3]);
    expect(recommend(answers)!.top.agent).toBe("aeon");
    expect(recommend(answers)!.tied).toBe(true);
  });

  it("falls back to the fixed order when score and strong matches both tie", () => {
    // With the same single agent listed twice in different orders the result must follow TIE_BREAK_ORDER.
    const all = rankAgents(EMPTY_ANSWERS);
    expect(all.map((r) => r.agent)).toEqual([...TIE_BREAK_ORDER]);
    const reversed = rankAgents(EMPTY_ANSWERS, [...TIE_BREAK_ORDER].reverse());
    expect(reversed.map((r) => r.agent)).toEqual([...TIE_BREAK_ORDER]);
  });

  it("does not flag a tie when the top agent leads", () => {
    expect(recommend(EXAMPLE_ANSWERS.coder)!.tied).toBe(false);
  });

  it("gives the same ranking whatever order the agents are passed in", () => {
    const a = rankAgents(EXAMPLE_ANSWERS.chat, [...AGENT_PICKER_KEYS]);
    const b = rankAgents(EXAMPLE_ANSWERS.chat, [...AGENT_PICKER_KEYS].reverse());
    expect(b).toEqual(a);
  });

  it("copes with a single agent and with none", () => {
    expect(recommend(A({}), ["hermes"])!.runnerUp).toBeNull();
    expect(recommend(A({}), ["hermes"])!.tied).toBe(false);
    expect(recommend(A({}), [])).toBeNull();
  });
});

describe("share links", () => {
  it("round-trips answers and leaves unanswered questions out", () => {
    const answers = A({ hands: "" });
    const query = serializeAgentPickerParams(answers);
    expect(query).not.toContain("hands");
    expect(parseAgentPickerParams(query)).toEqual(answers);
  });

  it("writes nothing for the empty state", () => {
    expect(serializeAgentPickerParams(EMPTY_ANSWERS)).toBe("");
  });

  it("drops values that are not on the allow-list, including hand-edited ones", () => {
    const parsed = parseAgentPickerParams("?job=<script>&where=telegram&focus=code&hands=__proto__&uptime=&sub=claude&evil=1");
    expect(parsed).toEqual({ ...EMPTY_ANSWERS, where: "telegram", focus: "code", sub: "claude" });
  });

  it("only ever serialises allow-listed keys and values", () => {
    const query = serializeAgentPickerParams({ ...A({}), job: "x" });
    expect([...new URLSearchParams(query).keys()].every((k) => (QUESTION_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(query).not.toContain("job=");
  });

  it("builds a summary from answer labels and agent names only", () => {
    const answers = A({});
    const text = summaryText(answers, recommend(answers)!);
    expect(text).toMatch(/^Agent Picker: Hermes/);
    expect(text).toContain("Runner-up: OpenClaw");
    expect(text).toContain("Where: Telegram");
  });
});

describe("facts", () => {
  it("are dated and sourced with real https URLs", () => {
    expect(AGENT_PICKER_FACTS.lastVerified).toBe("2026-11-12");
    expect(AGENT_PICKER_FACTS.sources.length).toBeGreaterThanOrEqual(8);
    for (const s of AGENT_PICKER_FACTS.sources) expect(s.url).toMatch(/^https:\/\/[^\s]+$/);
  });

  it("make no banned claim anywhere in the picker's own copy", () => {
    const all = [...strings(QUESTIONS), ...strings(AGENT_PROFILES), ...strings(HERMES_VS_OPENCLAW_ROWS)];
    for (const text of all) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
    }
  });
});

describe("catalog entry", () => {
  const entry = AGENT_PICKER_ENTRY;

  it("carries the names the task fixed", () => {
    expect(entry.slug).toBe("hermes-vs-openclaw");
    expect(entry.componentKey).toBe("agent-picker");
    expect(entry.primaryKeyword).toBe("hermes vs openclaw");
    expect(entry.h1).toBe("Hermes or OpenClaw: which agent fits you?");
  });

  it("keeps titles and the description within limits", () => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/Hivra/);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("has the blocks the page renders", () => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    expect(entry.method!.paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(entry.method!.paragraphs.flatMap((p) => p.sources ?? []).length).toBeGreaterThanOrEqual(2);
    expect(entry.method!.lastVerified).toBe(AGENT_PICKER_FACTS.lastVerified);
    expect(entry.examples!.length).toBeGreaterThanOrEqual(3);
    expect(entry.vendors.length).toBeGreaterThan(0);
  });

  it("links only to routes the existing catalog tests allow", () => {
    const allowed = new Set(["/pricing", "/agents/claude-code", "/agents/codex", "/blog/claude-max-vs-pro-for-claude-code", "/blog/codex-resume-session"]);
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) expect(allowed.has(link.href)).toBe(true);
  });

  it("holds every example output equal to what the picker prints", () => {
    const answers = Object.values(EXAMPLE_ANSWERS);
    entry.examples!.forEach((example, i) => {
      const r = recommend(answers[i])!;
      expect(example.command).toBe(r.ranking.map((row, n) => `${n + 1}. ${AGENT_PROFILES[row.agent].name} (${row.score} of ${r.maxScore})`).join("\n"));
    });
    expect(entry.examples![0].result).toMatch(/level at the top/);
    expect(recommend(EXAMPLE_ANSWERS.chat)!.tied).toBe(true);
    expect(recommend(EXAMPLE_ANSWERS.coder)!.top.agent).toBe("claude-code");
    expect(recommend(EXAMPLE_ANSWERS.scheduled)!.top.agent).toBe("aeon");
    expect(recommend(EXAMPLE_ANSWERS.scheduled)!.runnerUp?.agent).toBe("agent-zero");
  });

  it("makes no banned claim in any string of the entry", () => {
    const text = strings(entry).join("\n");
    for (const s of strings(entry)) expect({ s, hits: findBannedClaims(s) }).toEqual({ s, hits: [] });
    expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
  });

  it("states the entry plan with its size wherever it names the price", () => {
    const text = strings(entry).join("\n");
    for (const mention of text.match(/\$9\.99[^.]*\./g) ?? []) expect(mention).toMatch(/2 vCPU and 4 GB/);
    expect(text).not.toMatch(/free (?:plan|tier|trial)|\$0/i);
  });
});
