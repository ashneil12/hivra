import { article } from "../articles/is-openclaw-free-what-it-costs-to-run";

const spendCapSection = article.sections.find(({ heading }) => heading === "How do you cap the bill?");
const openAiSpendLimit = spendCapSection?.paragraphs.find((paragraph) => paragraph.startsWith("OpenAI:"));
const spendLimitFaq = article.faqs.find(({ q }) => q === "Can OpenClaw limit how much I spend on the model?");

describe("OpenClaw provider spend-limit copy", () => {
  it("qualifies OpenAI hard-limit enforcement in the summary, body and FAQ", () => {
    expect(article.shortAnswer).toContain("not an exact bill ceiling");
    expect(article.shortAnswer).toContain("slightly exceed");
    expect(openAiSpendLimit).toContain("Enforcement is not instantaneous");
    expect(openAiSpendLimit).toContain("slightly exceed the configured limit");
    expect(spendLimitFaq?.a).toContain("enforcement is not instantaneous");
    expect(spendLimitFaq?.a).toContain("slightly exceed the configured amount");

    const copy = [article.shortAnswer, ...article.sections.flatMap(({ paragraphs }) => paragraphs), ...article.faqs.map(({ a }) => a)].join("\n");
    expect(copy).not.toContain("the one limit that stops a surprise bill");
    expect(copy).not.toContain("The limit that holds is the one at the provider");
    expect(copy).not.toContain("Past that amount, API requests come back with a 429 error instead of running.");
  });

  it("keeps the provider-spend FAQ plain text", () => {
    const answer = spendLimitFaq?.a ?? "";
    expect(answer).not.toContain("`");
    expect(answer).not.toMatch(/\[[^\]]+\]\(/);
    expect(answer).not.toMatch(/https?:\/\//i);
  });
});
