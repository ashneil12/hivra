import { BLOG_ARTICLES } from "@/lib/blog-data";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { BLOG_TOPICS, topicForArticle } from "../topics";
import { article } from "../articles/codex-pricing-by-chatgpt-plan";

// Pins OpenAI plan prices and the October 2026 dates read on 5 October 2026 from OpenAI's own pages.
const SLUG = "codex-pricing-by-chatgpt-plan";
const DATED = "5 October 2026";

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

function tableRows(copy: string): string[][] {
  return copy
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|") && !/^\|[-| ]+\|$/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

describe("Codex pricing by ChatGPT plan article", () => {
  it("is registered under its slug in the hosting-and-costs topic after the Claude plan hub", () => {
    expect(article.slug).toBe(SLUG);
    expect(BLOG_ARTICLES[SLUG]).toBe(article);
    expect(topicForArticle(SLUG)?.slug).toBe("hosting-and-costs");
    const topic = BLOG_TOPICS.find((candidate) => candidate.slug === "hosting-and-costs")!;
    expect(topic.articles.indexOf(SLUG)).toBe(topic.articles.indexOf("claude-max-vs-pro-for-claude-code") + 1);
  });

  it("opens with a 40 to 60 word dated short answer that states the host does not raise limits", () => {
    const answer = article.shortAnswer ?? "";
    const words = answer.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect(answer).toContain(DATED);
    expect(answer).toMatch(/does not change .*Codex limits|does not change Codex limits/);
    expect(answer).toContain("Pro 500");
    expect(answer).toContain("Astra Ultrafast");
  });

  it("keeps the search title and description inside the limits", () => {
    expect((article.metaTitle ?? "").length).toBeLessThanOrEqual(58);
    expect(article.metaTitle).toContain("Codex pricing");
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    expect(article.faqs.length).toBeLessThanOrEqual(11);
  });

  it("pins the OpenAI plan prices from the pricing page and Pro tiers help article", () => {
    const planSection = article.sections.find((section) => section.heading.includes("Codex pricing by ChatGPT plan"))!;
    const rows = tableRows(planSection.paragraphs.join("\n"));
    const byPlan = Object.fromEntries(rows.map((row) => [row[0], row]));
    expect(byPlan.Free[1]).toBe("$0");
    expect(byPlan.Go[1]).toBe("$8");
    expect(byPlan.Plus[1]).toBe("$20");
    expect(byPlan["Pro 100"][1]).toBe("$100");
    expect(byPlan["Pro 200"][1]).toBe("$200");
    expect(byPlan["Pro 500"][1]).toBe("$500");
    expect(byPlan["API key"][1]).toBe("Pay per token");
    expect(byPlan["Pro 500"][2]).toContain("Astra Ultrafast");
    expect(byPlan["Pro 100"][2]).toContain("Ultrafast not included");
    expect(byPlan["Pro 200"][2]).toContain("Ultrafast not included");
  });

  it("dates the Pro 200 grandfathering end and GPT-5.5 retirement from OpenAI's pages", () => {
    expect(fullCopy).toContain("29 October 2026");
    expect(fullCopy).toContain("14 October 2026");
    expect(fullCopy).toContain("22 September 2026");
    expect(fullCopy).toContain("https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers");
    expect(fullCopy).toContain("https://learn.chatgpt.com/docs/pricing");
    expect(fullCopy).toContain("https://learn.chatgpt.com/codex/agent-configuration/speed");
  });

  it("does not invent Nx Plus multiples OpenAI's Pro tiers article leaves unpublished", () => {
    expect(fullCopy).not.toMatch(/\b(?:5|10|20|25)\s*x\s+Plus\b/i);
    expect(fullCopy).toContain("does not publish numeric");
  });

  it("says a computer of your own does not change Codex limits, and names Hivra by price and size only", () => {
    expect(fullCopy).toContain("does not raise your Codex allowance");
    expect(fullCopy).toContain(ENTRY_PLAN_PRICE);
    expect(fullCopy).toContain(ENTRY_PLAN_SIZE);
    expect(fullCopy).toContain(LARGER_PLAN_PRICE);
    expect(fullCopy).toContain(LARGER_PLAN_SIZE);
    expect(fullCopy).toContain(MONEY_BACK_GUARANTEE);
    expect(fullCopy).toContain("not affiliated with OpenAI");
    expect(fullCopy).not.toMatch(/\bHivra (?:Pro|Power)\b/);
      });

  it("uses no em or en dashes in the shipped copy", () => {
    expect(fullCopy).not.toMatch(/[—–]/);
  });
});
