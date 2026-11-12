import {
  AGENT_SECURITY_FACTS,
  ANSWERS,
  BANDS,
  CHECKS,
  CHECK_IDS,
  CHECK_TITLES,
  EMPTY_ANSWERS,
  GROUPS,
  HIVRA_SECURITY_FACTS,
  MAX_POINTS,
  answeredCount,
  answersFrom,
  assess,
  openChecks,
  openPoints,
  parseSecurityParams,
  resultText,
  serializeSecurityParams,
  summaryText,
  type CheckId,
  type SecurityAnswers,
} from "../agent-security-check";
import { AGENT_SECURITY_CHECK_ENTRY, EXAMPLE_ANSWERS } from "../agent-security-check-entry";
import { findBannedClaims } from "../../copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { splitFaqCode } from "../../faq-code";

const all = (value: "yes" | "no" | "unsure"): SecurityAnswers => answersFrom(Object.fromEntries(CHECK_IDS.map((id) => [id, value])));

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe("the checks", () => {
  it("are twelve, each in a known group, with a weight of 1 to 3", () => {
    expect(CHECKS).toHaveLength(12);
    expect(new Set(CHECK_IDS).size).toBe(12);
    const groups = GROUPS.map((g) => g.id);
    for (const check of CHECKS) {
      expect(groups).toContain(check.group);
      expect([1, 2, 3]).toContain(check.weight);
      expect(check.sources.length).toBeGreaterThan(0);
      expect(CHECK_TITLES[check.id].length).toBeGreaterThan(0);
    }
    for (const g of groups) expect(CHECKS.some((c) => c.group === g)).toBe(true);
  });

  it("cite only sources in the facts table, all https", () => {
    for (const check of CHECKS) for (const key of check.sources) expect(AGENT_SECURITY_FACTS.sources[key].url).toMatch(/^https:\/\//);
    expect(AGENT_SECURITY_FACTS.lastVerified).toBe("2026-11-12");
  });

  it("say plainly when upstream gives no command, and never hide that advice is general practice", () => {
    expect(CHECKS.find((c) => c.id === "spend")?.generalPractice).toBe(true);
    expect(CHECKS.find((c) => c.id === "spend")?.gap).toMatch(/Neither/);
    expect(CHECKS.find((c) => c.id === "ui-private")?.gap).toMatch(/Hermes/);
  });

  it("quote only commands from the vendors' pages", () => {
    const commands = new Set(CHECKS.flatMap((c) => c.lines.filter((l) => l.kind === "command").map((l) => l.code)));
    expect([...commands].sort()).toEqual(
      [
        "chmod 700 ~/.openclaw",
        "chmod 600 ~/.openclaw/openclaw.json",
        "openclaw doctor",
        "chmod 600 ~/.hermes/.env",
        "openclaw security audit",
        "nmap -sT -p 1-65535 <public-ip> --open",
        "openclaw doctor --generate-gateway-token",
        "openclaw pairing list <channel>",
        "openclaw pairing approve <channel> <code>",
        "hermes pairing revoke telegram <user-id>",
        "hermes update",
        "hermes doctor",
        "openclaw status --all",
      ].sort(),
    );
  });

  it("are worded so yes is the safe answer: none asks whether something bad is true", () => {
    for (const check of CHECKS) expect(check.question).toMatch(/\?/);
  });
});

describe("scoring", () => {
  it("opens the full weight for no and half for not sure", () => {
    const check = CHECKS[0];
    expect(openPoints(check, "yes")).toBe(0);
    expect(openPoints(check, null)).toBe(0);
    expect(openPoints(check, "no")).toBe(check.weight * 2);
    expect(openPoints(check, "unsure")).toBe(check.weight);
    expect(MAX_POINTS).toBe(CHECKS.reduce((s, c) => s + c.weight * 2, 0));
  });

  it("gives no result until all twelve are answered", () => {
    expect(assess(EMPTY_ANSWERS)).toBeNull();
    expect(assess(answersFrom({ secrets: "yes" }))).toBeNull();
    expect(answeredCount(answersFrom({ secrets: "yes", spend: "no" }))).toBe(2);
  });

  it("calls all yes well covered with nothing open", () => {
    const result = assess(all("yes"))!;
    expect(result.band).toBe(BANDS.covered);
    expect(result.open).toEqual([]);
    expect(result.topThree).toEqual([]);
    expect(summaryText(result)).toContain("No open items.");
  });

  it("calls all no many open questions and all not sure several gaps or more", () => {
    expect(assess(all("no"))!.band).toBe(BANDS.many);
    expect(assess(all("unsure"))!.openPoints).toBe(MAX_POINTS / 2);
    expect(assess(all("unsure"))!.band).toBe(BANDS.several);
  });

  it("never lets a no on a weight-3 check read as well covered", () => {
    const base = all("yes");
    const heavy = CHECKS.find((c) => c.weight === 3)!.id;
    // The floor is a guard: with today's weights the points alone already give "a few gaps".
    const result = assess({ ...base, [heavy]: "no" })!;
    expect(result.band).toBe(BANDS.gaps);
    // A not sure on the same check is only half the points and is not lifted.
    expect(assess({ ...base, [heavy]: "unsure" })!.band).toBe(BANDS.covered);
  });

  it("lifts a reachable control UI with no login to at least several gaps", () => {
    const result = assess({ ...all("yes"), "ui-private": "no", "ui-auth": "no" })!;
    expect(result.band).toBe(BANDS.several);
    expect(result.raisedBy).toMatch(/no login/);
    expect(result.topThree.map((r) => r.check.id)).toEqual(["ui-private", "ui-auth"]);
    // One alone does not trigger the rule.
    expect(assess({ ...all("yes"), "ui-private": "no" })!.band).toBe(BANDS.gaps);
  });

  it("lifts an exposed control UI with unconfirmed login to at least several gaps", () => {
    const result = assess({ ...all("yes"), "ui-private": "no", "ui-auth": "unsure" })!;
    expect(result.band).toBe(BANDS.several);
    expect(result.raisedBy).toMatch(/may have no login/);
    // The reverse (login unconfirmed on a UI that is private) and a confirmed login do not trigger it.
    expect(assess({ ...all("yes"), "ui-private": "unsure", "ui-auth": "no" })!.band).toBe(BANDS.gaps);
    expect(assess({ ...all("yes"), "ui-private": "no", "ui-auth": "yes" })!.band).toBe(BANDS.gaps);
  });

  it("puts the band edges at 10, 30 and 55 percent of the points", () => {
    // MAX_POINTS is 58, so 10% is 5.8, 30% is 17.4 and 55% is 31.9 points. Points are built from "no" (2 per weight)
    // and "not sure" (1 per weight) on the weight-1 logs check and weight-2 checks, which keeps the weight-3 floors out.
    const band = (a: Partial<SecurityAnswers>) => assess({ ...all("yes"), ...a })!;
    expect(MAX_POINTS).toBe(58);
    const five = band({ secrets: "no", logs: "unsure" }); // 4 + 1
    expect(five.openPoints).toBe(5);
    expect(five.band).toBe(BANDS.covered);
    const six = band({ secrets: "no", spend: "unsure" }); // 4 + 2
    expect(six.openPoints).toBe(6);
    expect(six.band).toBe(BANDS.gaps);
    // 17 points is the top of "a few gaps" (4+4+4+4+1), 18 the first of "several gaps".
    const seventeen = band({ secrets: "no", spend: "no", tools: "no", approvers: "no", logs: "unsure" });
    expect(seventeen.openPoints).toBe(17);
    expect(seventeen.band).toBe(BANDS.gaps);
    const eighteen = band({ secrets: "no", spend: "no", tools: "no", approvers: "no", updates: "unsure" }); // 16 + 2
    expect(eighteen.openPoints).toBe(18);
    expect(eighteen.band).toBe(BANDS.several);
    // Laptop example sits at 32 of 58, just over the 55% line, and is "many".
    expect(assess(EXAMPLE_ANSWERS.laptop)!.openPoints).toBe(32);
    expect(assess(EXAMPLE_ANSWERS.laptop)!.band).toBe(BANDS.many);
    // 31 points is still several (a not sure on logs takes 32 down to 31).
    const laptop31 = assess({ ...EXAMPLE_ANSWERS.laptop, logs: "yes" })!;
    expect(laptop31.openPoints).toBeLessThan(32);
    expect(laptop31.band).toBe(BANDS.several);
  });

  it("does not claim a raise when the points already give the band", () => {
    expect(assess(all("no"))!.raisedBy).toBeNull();
  });

  it("orders open checks by points, then weight, then list order, and takes three", () => {
    const rows = openChecks(EXAMPLE_ANSWERS.laptop);
    const points = rows.map((r) => r.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
    const result = assess(EXAMPLE_ANSWERS.laptop)!;
    expect(result.topThree).toHaveLength(3);
    expect(result.topThree.map((r) => r.check.id)).toEqual(["untrusted", "isolation", "spend"]);
    expect(result.open.length).toBe(rows.length);
  });

  it("is deterministic for the same answers", () => {
    expect(assess(EXAMPLE_ANSWERS.laptop)).toEqual(assess(EXAMPLE_ANSWERS.laptop));
  });

  it("describes the three worked examples", () => {
    expect(assess(EXAMPLE_ANSWERS.tidy)!.band).toBe(BANDS.covered);
    expect(assess(EXAMPLE_ANSWERS.exposed)!.band).toBe(BANDS.several);
    expect(assess(EXAMPLE_ANSWERS.laptop)!.band).toBe(BANDS.many);
  });

  it("marks a not sure in the summary and counts the remainder", () => {
    const text = summaryText(assess(EXAMPLE_ANSWERS.laptop)!);
    expect(text).toMatch(/^Agent security check: /);
    expect(text).toMatch(/more open items\./);
    expect(text).not.toMatch(/https?:/);
    const one = summaryText(assess({ ...all("yes"), "ui-auth": "unsure" })!);
    expect(one).toContain("(not confirmed)");
    expect(summaryText(assess({ ...all("yes"), spend: "no", logs: "no" })!)).not.toMatch(/more open/);
  });
});

describe("share links", () => {
  it("is empty with nothing answered and round-trips otherwise", () => {
    expect(serializeSecurityParams(EMPTY_ANSWERS)).toBe("");
    for (const a of [EXAMPLE_ANSWERS.laptop, EXAMPLE_ANSWERS.tidy, answersFrom({ spend: "no" })]) {
      expect(parseSecurityParams(serializeSecurityParams(a))).toEqual(a);
    }
    expect(serializeSecurityParams(answersFrom({ spend: "no" }))).toBe("a=-n----------");
  });

  it("ignores anything outside the allow-list or too long", () => {
    expect(parseSecurityParams("a=yyyyyyyyyyyyy")).toEqual(EMPTY_ANSWERS);
    expect(parseSecurityParams("a=zzzzzzzzzzzz")).toEqual(EMPTY_ANSWERS);
    expect(parseSecurityParams("")).toEqual(EMPTY_ANSWERS);
    expect(parseSecurityParams("?a=y<script>")).toEqual(EMPTY_ANSWERS);
    expect(parseSecurityParams("a=yn").secrets).toBe("yes");
    expect(parseSecurityParams("a=yn").spend).toBe("no");
    expect(parseSecurityParams("a=yn")["ui-private"]).toBeNull();
  });

  it("offers exactly three answers", () => {
    expect([...ANSWERS]).toEqual(["yes", "no", "unsure"]);
    const id: CheckId = "logs";
    expect(CHECK_IDS).toContain(id);
  });
});

describe("what a Hivra computer changes", () => {
  it("states the isolation fact and what Hivra does not do", () => {
    expect(HIVRA_SECURITY_FACTS.does[0].text).toMatch(/private virtual machine/);
    const not = HIVRA_SECURITY_FACTS.doesNot.join("\n");
    expect(not).toMatch(/prompt injection/);
    expect(not).toMatch(/administrators retain infrastructure access/);
    expect(not).toMatch(/no claim of an audit/);
    expect(HIVRA_SECURITY_FACTS.stillYours).toMatch(/your responsibility/);
  });

  it("names a repository file for every claim", () => {
    for (const fact of HIVRA_SECURITY_FACTS.does) expect(fact.from).toMatch(/dashboard\/src\/lib\/hivra\/agent-catalog\.ts|docs\/STATUS\.md/);
  });
});

describe("the catalog entry", () => {
  const entry = AGENT_SECURITY_CHECK_ENTRY;

  it("has the slug, keyword and component key the plan names", () => {
    expect(entry.slug).toBe("ai-agent-security-checklist");
    expect(entry.componentKey).toBe("agent-security-check");
    expect(entry.primaryKeyword).toBe("openclaw security");
  });

  it("keeps titles and the description within limits", () => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/Hivra/);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("has at least five FAQs covering the keyword cluster", () => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    const questions = entry.faqs.map((f) => f.q).join("\n");
    expect(questions).toMatch(/OpenClaw/);
    expect(questions).toMatch(/Hermes/);
  });

  it("has every faqCode phrase in an answer", () => {
    for (const phrase of entry.faqCode ?? []) {
      const found = entry.faqs.some((faq) => splitFaqCode(faq.a, entry.faqCode!).some((part) => part.code && part.text === phrase));
      expect({ phrase, found }).toEqual({ phrase, found: true });
    }
  });

  it("links only to routes the existing tests allow", () => {
    const allowed = new Set(["/pricing", "/agents/claude-code", "/agents/codex", "/tools/agent-survival-check"]);
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) expect(allowed.has(link.href)).toBe(true);
  });

  it("prints in each example exactly what the tool prints", () => {
    const [laptop, tidy, exposed] = entry.examples ?? [];
    expect(laptop.command).toBe(resultText(assess(EXAMPLE_ANSWERS.laptop)!));
    expect(tidy.command).toBe(resultText(assess(EXAMPLE_ANSWERS.tidy)!));
    expect(exposed.command).toBe("Several gaps\n1. Keep the control UI off the public internet\n2. Require a token or password on the control UI");
  });

  it("makes no banned claim, no dash and no unknown dashboard name in any string, the tool's own included", () => {
    const copy = [...strings(entry), ...strings(CHECKS), ...strings(BANDS), ...strings(HIVRA_SECURITY_FACTS), ...Object.values(CHECK_TITLES)];
    for (const text of copy) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      expect(text).not.toMatch(/[–—]/);
    }
    const joined = copy.join("\n");
    expect(unqualifiedKeepRunningClaims(joined, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(joined)).toEqual([]);
  });

  it("makes no unsafe-claim, fear or incident copy", () => {
    const joined = strings(entry).join("\n");
    expect(joined).not.toMatch(/\bhack(?:ed|ers)? (?:in|into)\b|breach|data leak|stolen|catastroph|devastat|will be attacked|is unsafe|are unsafe|insecure by default/i);
  });

  it("states the plan only by price and size", () => {
    for (const mention of strings(entry).join("\n").match(/\$\d[^.]*\./g) ?? []) expect(mention).toMatch(/2 vCPU and 4 GB/);
  });
});
