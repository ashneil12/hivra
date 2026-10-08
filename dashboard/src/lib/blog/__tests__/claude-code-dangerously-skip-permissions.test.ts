import fs from "fs";
import path from "path";

import { agentSurfaceLabel } from "@/lib/agent-computers/agent-surfaces";
import { BLOG_ARTICLES, BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, PLAN_SUMMARY } from "@/lib/blog/plan-facts";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { BLOG_TOPICS, topicForArticle } from "../topics";
import { article } from "../articles/claude-code-dangerously-skip-permissions";

// The page quotes flags from Anthropic's and OpenAI's docs (checked 2 October 2026; the date lives in the article's source
// comment, not in reader copy, per Ash's voice rule of 2026-10-06), and flags from Hivra's own code.
// Both kinds drift. These tests pin the numbers and wording that must not be "tidied", tie the Hivra table to the source
// files it was read from, and keep out the claims the brief ruled out (nothing about egress or credential isolation,
// no blanket "safe", no "Limited stops every command", no "Read-only can't run commands").

const SLUG = "claude-code-dangerously-skip-permissions";
const READ_STAMP = /\b(?:read|checked)(?: on)? \d{1,2} \w+ 20\d\d|\b\d{1,2} Oct 2026\b/i;

const sectionCopy = article.sections.flatMap((section) => section.paragraphs).join("\n\n");
const fullCopy = [
  article.title,
  article.metaTitle ?? "",
  article.metaDescription,
  article.tagline,
  article.intro,
  article.shortAnswer ?? "",
  ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
  ...article.faqs.flatMap(({ q, a }) => [q, a]),
].join("\n");

const root = path.join(__dirname, "..", "..", "..", "..");
const serverSource = fs.readFileSync(path.join(root, "provisioner", "hivra-chat", "server.js"), "utf8");
const manageSource = fs.readFileSync(path.join(root, "src", "components", "hivra", "HivraManage.tsx"), "utf8");
const articleSource = fs.readFileSync(path.join(__dirname, "..", "articles", `${SLUG}.ts`), "utf8");

function sectionText(heading: string): string {
  const section = article.sections.find((candidate) => candidate.heading === heading);
  if (!section) throw new Error(`No section called ${heading}`);
  return section.paragraphs.join("\n\n");
}

/** Markdown table rows as cell arrays, header and divider dropped. */
function tableRows(copy: string): string[][] {
  return copy
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|") && !/^\|[-| ]+\|$/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

const HIVRA_SECTION = "What does Hivra run Claude Code and Codex with?";

describe("Claude Code --dangerously-skip-permissions article", () => {
  it("is registered under its slug, in the keep-agents-running topic right after the unattended-safety post", () => {
    expect(article.slug).toBe(SLUG);
    expect(BLOG_ARTICLES[SLUG]).toBe(article);
    expect(topicForArticle(SLUG)?.slug).toBe("keep-agents-running");
    const topic = BLOG_TOPICS.find((candidate) => candidate.slug === "keep-agents-running")!;
    expect(topic.articles.indexOf(SLUG)).toBe(topic.articles.indexOf("is-it-safe-to-leave-an-ai-agent-running-unattended") + 1);
  });

  it("opens with a 40 to 60 word short answer that names the container advice and the credentials limit", () => {
    const answer = article.shortAnswer ?? "";
    const words = answer.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect(answer).not.toMatch(READ_STAMP);
    expect(answer).toContain("container or VM");
    expect(answer).toContain("non-root user");
    expect(answer).toContain("It doesn't protect what you sign in to on it.");
  });

  it("keeps the search title and description inside the limits and names the flag", () => {
    expect((article.metaTitle ?? "").length).toBeLessThanOrEqual(58);
    expect(article.metaTitle).toContain("--dangerously-skip-permissions");
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    expect(article.metaDescription).not.toMatch(READ_STAMP);
    expect(article.faqs.length).toBeLessThanOrEqual(11);
  });

  it("carries no read-on-date stamps and tells the reader to run claude --version", () => {
    expect(sectionCopy).not.toMatch(READ_STAMP);
    expect(sectionCopy).toContain("run `claude --version` before you trust a line");
    expect(sectionCopy).toContain("25 March 2026");
  });

  it("pins the Anthropic numbers and versions that must not drift without a re-read of the docs", () => {
    // Auto mode classifier figures, from Anthropic's engineering post of 25 March 2026.
    expect(sectionCopy).toContain("wrongly blocked 0.4%");
    expect(sectionCopy).toContain("10,000 real tool calls");
    expect(sectionCopy).toContain("17% of 52 real cases");
    expect(sectionCopy).toContain("5.7% of 1,000 synthetic data-exfiltration attempts");
    expect(sectionCopy).toContain("users approve 93% of permission prompts");
    expect(sectionCopy).toContain("read those rates as March's, not today's");
    // Documented thresholds and versions.
    expect(sectionCopy).toContain("After 3 blocks in a row or 20 in total");
    expect(sectionCopy).toContain("v2.1.200 or later");
    expect(sectionCopy).toContain("v2.1.283");
    expect(sectionCopy).toContain("v2.1.281 or later");
    expect(sectionCopy).toContain("v2.1.257 or later");
    expect(sectionCopy).toContain("two-minute countdown");
  });

  it("says a project-file bypassPermissions value leaves the session in Manual mode, as Anthropic's permission modes page does", () => {
    const fallback = "has no effect on v2.1.257 or later, and the session starts in Manual mode.";
    expect(sectionCopy).toContain(fallback);
    expect(article.faqs.find(({ q }) => q.includes("middle of a session"))?.a).toContain(fallback);
    expect(sectionCopy).not.toContain("would have started in anyway");
  });

  it("explains that allow rules do nothing in bypass mode and deny rules still block", () => {
    expect(sectionCopy).toContain("Deny rules still block in every mode, bypass included");
    expect(sectionCopy).toContain("Allow rules do nothing here");
    expect(article.faqs.find(({ q }) => q.includes("ignore deny rules"))?.a).toContain("Allow rules have no effect in bypass mode");
  });

  it("lists the six permission modes with the flag against bypassPermissions", () => {
    const modes = tableRows(sectionText("What are Claude Code's permission modes?")).map((row) => row[0]);
    expect(modes).toEqual(["`default` (Manual)", "`acceptEdits`", "`plan`", "`auto`", "`dontAsk`", "`bypassPermissions`"]);
    expect(sectionText("What are Claude Code's permission modes?")).toContain("| `bypassPermissions` | Everything | `--dangerously-skip-permissions` |");
  });

  it("states the Codex flag, its alias and its two dials as OpenAI's pages give them", () => {
    const codex = sectionText("What is the Codex equivalent of --dangerously-skip-permissions?");
    expect(codex).toContain("`--dangerously-bypass-approvals-and-sandbox`, which OpenAI also lets you type as `--yolo`");
    expect(codex).toContain("| `--sandbox` | `read-only`, `workspace-write`, `danger-full-access` |");
    expect(codex).toContain("| `--ask-for-approval` | `on-request`, `never` |");
    expect(codex).toContain("`-a never` works with every sandbox mode");
    expect(codex).toContain("That's OpenAI's stated default for the CLI. We haven't checked it on a Hivra computer.");
  });

  describe("the Hivra defaults table", () => {
    const rows = tableRows(sectionText(HIVRA_SECTION));
    const byLabel = Object.fromEntries(rows.map(([label, claude, codex]) => [label, { claude, codex }]));

    it("has the three presets in the order the Manage tab shows them", () => {
      expect(rows.map((row) => row[0])).toEqual(["Full access (the default)", "Limited", "Read-only"]);
      for (const label of ["Full access", "Limited", "Read-only"]) {
        expect(manageSource).toContain(`label: "${label}"`);
      }
      expect(manageSource).toContain("Applies from the next message");
    });

    it("matches the flags the chat gateway builds for Claude Code", () => {
      expect(byLabel["Full access (the default)"].claude).toBe("`claude -p` with `--dangerously-skip-permissions`");
      expect(byLabel["Limited"].claude).toBe("Keeps the skip flag, adds `--disallowedTools Bash`");
      expect(byLabel["Read-only"].claude).toBe("Drops the skip flag");
      expect(serverSource).toContain('const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];');
      expect(serverSource).toContain('if (restrict !== "readonly") args.push("--dangerously-skip-permissions");');
      expect(serverSource).toContain('if (restrict === "limited") args.push("--disallowedTools", "Bash");');
      // Chat passes no --permission-mode, so it never asks for auto mode.
      expect(serverSource).not.toMatch(/args\.push\("--permission-mode"/);
    });

    it("matches the flags the chat gateway builds for Codex", () => {
      expect(byLabel["Full access (the default)"].codex).toBe("`codex exec` with `--dangerously-bypass-approvals-and-sandbox`");
      expect(byLabel["Limited"].codex).toBe("`--sandbox workspace-write`");
      expect(byLabel["Read-only"].codex).toBe("`--sandbox read-only`");
      expect(serverSource).toContain('if (restrict === "readonly") flags.push("--sandbox", "read-only");');
      expect(serverSource).toContain('else if (restrict === "limited") flags.push("--sandbox", "workspace-write");');
      expect(serverSource).toContain('else flags.push("--dangerously-bypass-approvals-and-sandbox");');
    });

    it("says Chat is the default path and names only dashboard labels that exist", () => {
      const copy = sectionText(HIVRA_SECTION);
      expect(copy).toContain("By default, Chat runs Claude Code with the skip flag and Codex with its bypass flag.");
      expect(agentSurfaceLabel("chat")).toBe("Chat");
      expect(agentSurfaceLabel("manage")).toBe("Manage");
      expect(agentSurfaceLabel("box")).toBe("Terminal");
      expect(agentSurfaceLabel("terminal", { name: "Claude Code" })).toBe("Claude Code session");
      expect(agentSurfaceLabel("terminal", { name: "Codex" })).toBe("Codex session");
      expect(unknownDashboardNames(fullCopy)).toEqual([]);
    });

    it("never says what mode the session tabs start in, and never states a CLI version for a Hivra computer", () => {
      const copy = sectionText(HIVRA_SECTION);
      expect(copy).toContain("start the CLI with no permission flags");
      expect(copy).toContain("so you get its own default for its version and your account");
      expect(fullCopy).not.toMatch(/\b(?:2\.1\.246|0\.149\.1)\b/);
    });
  });

  it("words Limited and Read-only the way the code supports, and never overstates either", () => {
    const copy = sectionText(HIVRA_SECTION);
    expect(copy).toContain("Limited removes the Bash tool for Claude Code.");
    expect(copy).toContain("don't count on it as a lock on every shell command");
    expect(copy).toContain("reads and a built-in set of read-only commands still run");
    expect(fullCopy).not.toMatch(/won'?t run commands|can'?t run commands|no shell commands|stops? every shell command|blocks? every shell command/i);
  });

  it("makes no claim about egress, credential isolation or privacy inside a Hivra computer, and says so plainly", () => {
    const credentials = sectionText("What does a separate computer not protect?");
    expect(credentials).toContain("Hivra's admins can reach the host machines these computers run on");
    expect(credentials).toContain("We're saying nothing, one way or the other, about outbound traffic limits or credential isolation on a Hivra computer.");
    expect(fullCopy).not.toMatch(/cannot read your|can'?t read your|never sees?|locked[- ]down|firewalled|private by default|your keys are safe/i);
  });

  it("never calls the flag, a Hivra computer or the VM safe, and never says a computer makes the flag safe", () => {
    // "doesn't make it safe" is the honest sentence, so only an unnegated claim fails.
    expect(fullCopy).not.toMatch(/(?<!n't )(?<!not )\b(?:makes?|keeps?) (?:the flag|it|this) safe\b/i);
    expect(fullCopy).not.toMatch(/\bsafe to run\b|\bperfectly safe\b|\bis (?:completely )?safe\b/i);
    // The only "safe" in a heading or question is the honest question itself.
    const questions = [...article.sections.map((s) => s.heading), ...article.faqs.map((f) => f.q)].filter((text) => /\bsafe\b/i.test(text));
    expect(new Set(questions)).toEqual(new Set(["Is --dangerously-skip-permissions safe?"]));
  });

  it("says plainly where the vendor's own cloud is the better pick", () => {
    expect(sectionCopy).toContain("If you only use Claude Code and your work lives on GitHub, start with Anthropic's cloud sessions.");
    expect(sectionCopy).toContain("A plain computer, ours included, makes no such promise.");
    expect(sectionCopy).toContain("A Hivra computer fits the last row only. In the other five rows, the pick in the middle column is the better call.");
  });

  it("states the plan facts from plan-facts, never hard-coded, and names plans by price and size only", () => {
    expect(sectionCopy).toContain(PLAN_SUMMARY);
    expect(sectionCopy).toContain(`The ${LARGER_PLAN_PRICE} plan is ${LARGER_PLAN_SIZE}.`);
    expect(articleSource).not.toMatch(/\$(?:9\.99|19\.99)/);
    expect(fullCopy).not.toMatch(/\b(?:Pro|Power|Starter|Studio|Max) plan\b|free trial|free plan/i);
  });

  it("keeps the non-affiliation line, the Remote Control silence and the token out", () => {
    expect(fullCopy).toContain("Hivra is independent and is not affiliated with Anthropic or OpenAI.");
    // Remote Control has not been tested on a Hivra computer. Only Anthropic's own note about the app appears.
    const remote = fullCopy.match(/[^.]*Remote Control[^.]*\./g) ?? [];
    for (const sentence of remote) expect(sentence).not.toMatch(/\bHivra\b/);
    expect(fullCopy).not.toMatch(/\$HIVRA|\$HermesOS|HermesOS|Hermes Cloud|Nous Research|crypto|wallet/i);
  });

  it("never calls a Hivra computer a box or an instance and avoids the retired vocabulary", () => {
    // "sandbox runtime" is Anthropic's own product name; any other "runtime" is the retired word for a computer.
    expect(fullCopy.replace(/sandbox runtime/gi, "")).not.toMatch(/Box Terminal|(?<!text )\bbox(?:es)?\b|\binstances?\b|\bruntimes?\b/i);
    expect(fullCopy).not.toMatch(/unmodified|in minutes|one[- ]click|instantly/i);
  });

  it("links the contextual articles to this guide, one sentence each", () => {
    const linkers = [
      "is-it-safe-to-leave-an-ai-agent-running-unattended",
      "keep-claude-code-running-24-7",
      "run-codex-24-7-in-the-cloud",
      "ai-agent-vps",
      "claude-code-remote-control",
      "claude-code-vs-codex-24-7",
    ];
    for (const slug of linkers) {
      const linker = BLOG_ARTICLES_LIST.find((candidate) => candidate.slug === slug);
      expect({ slug, links: linker?.sections.flatMap((s) => s.paragraphs).join("\n").includes(`](/blog/${SLUG})`) }).toEqual({ slug, links: true });
      expect(article.relatedArticles.map(({ slug: related }) => related)).not.toContain(SLUG);
    }
  });

  it("links to the vendor pages it reads from, and to no other external host", () => {
    const hosts = new Set([...sectionCopy.matchAll(/\]\(https?:\/\/([^/)\s]+)/g)].map((match) => match[1]));
    expect([...hosts].sort()).toEqual(["code.claude.com", "learn.chatgpt.com", "www.anthropic.com"]);
  });
});
