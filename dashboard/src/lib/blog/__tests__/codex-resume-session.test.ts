import fs from "fs";
import path from "path";

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, PLAN_SUMMARY } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { BLOG_TOPICS, topicForArticle } from "../topics";
import { article } from "../articles/codex-resume-session";

const SLUG = "codex-resume-session";
const DATED = "5 October 2026";
const CODEX_VER = "0.159.0";

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

describe("Codex resume session article", () => {
  it("is registered under its slug in keep-agents-running after the skip-permissions post", () => {
    expect(article.slug).toBe(SLUG);
    expect(BLOG_ARTICLES[SLUG]).toBe(article);
    expect(topicForArticle(SLUG)?.slug).toBe("keep-agents-running");
    const topic = BLOG_TOPICS.find((candidate) => candidate.slug === "keep-agents-running")!;
    expect(topic.articles.indexOf(SLUG)).toBe(topic.articles.indexOf("claude-code-dangerously-skip-permissions") + 1);
  });

  it("opens with a 40 to 60 word short answer that names the Codex resume commands and the storage path", () => {
    const answer = article.shortAnswer ?? "";
    const words = answer.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect(answer).toContain(DATED);
    expect(answer).toContain("codex resume --last");
    expect(answer).toContain("~/.codex/sessions/");
    expect(answer).toContain(CODEX_VER);
  });

  it("keeps the search title and description inside the limits", () => {
    expect((article.metaTitle ?? "").length).toBeLessThanOrEqual(58);
    expect(article.metaTitle).toContain("Resume a Codex");
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    expect(article.faqs.length).toBeLessThanOrEqual(11);
  });

  it("pins the Codex resume commands from the CLI reference and local help", () => {
    expect(fullCopy).toContain("codex resume --last");
    expect(fullCopy).toContain("codex resume --all");
    expect(fullCopy).toContain("codex resume --include-non-interactive");
    expect(fullCopy).toContain("codex exec resume --last");
    expect(fullCopy).toContain("codex fork");
    expect(fullCopy).toContain("https://developers.openai.com/codex/cli/reference");
    expect(fullCopy).toContain(CODEX_VER);
  });

  it("pins Claude Code resume flags and the 30-day default retention from Anthropic's sessions docs", () => {
    expect(fullCopy).toContain("claude --continue");
    expect(fullCopy).toContain("claude --resume");
    expect(fullCopy).toContain("cleanupPeriodDays");
    expect(fullCopy).toContain("30 days");
    expect(fullCopy).toContain("https://code.claude.com/docs/en/sessions");
    expect(fullCopy).toContain("~/.claude/projects/");
  });

  it("ties the Hivra chat resume claim to provisioner/hivra-chat/server.js", () => {
    expect(serverSource).toContain('"resume"');
    expect(serverSource).toMatch(/\["exec",\s*"resume"/);
    expect(serverSource).toContain('args.push("--resume", sessionId)');
    expect(fullCopy).toContain("codex exec resume");
    expect(fullCopy).toContain("claude --resume");
    expect(fullCopy).toContain("dashboard/provisioner/hivra-chat/server.js");
  });

  it("keeps F2 and backups out of the claims, and uses the shared keep-running sentence", () => {
    expect(fullCopy).toContain(CLI_RUN_LIFETIME);
    expect(fullCopy).toContain("We haven't verified that CLI session history and tmux sessions survive a closed laptop plus a browser reconnect");
    expect(fullCopy).toContain("Hivra does not promise backups of your sessions");
    expect(fullCopy).toContain("Export JSON and shared account memory exist for Claude Code and Codex computers only");
    expect(fullCopy).toContain(PLAN_SUMMARY);
    expect(fullCopy).toContain(LARGER_PLAN_PRICE);
    expect(fullCopy).toContain(LARGER_PLAN_SIZE);
    expect(fullCopy).toContain("not affiliated with OpenAI or Anthropic");
    expect(fullCopy).not.toMatch(/\bHivra (?:Pro|Power)\b/);
    expect(fullCopy).not.toMatch(/\b(?:box|instance)\b/i);
  });

  it("credits the early codex_continue tip and uses no em or en dashes", () => {
    expect(fullCopy).toContain("https://ian.is/post/codex-session-resume");
    expect(fullCopy).toContain("@fcoury");
    expect(fullCopy).not.toMatch(/[—–]/);
  });
});
