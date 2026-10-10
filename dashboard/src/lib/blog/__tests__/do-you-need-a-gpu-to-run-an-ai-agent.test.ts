import { BLOG_ARTICLES } from "@/lib/blog-data";
import { article } from "../articles/do-you-need-a-gpu-to-run-an-ai-agent";

describe("GPU requirements article", () => {
  it("is registered under its canonical slug", () => {
    expect(BLOG_ARTICLES[article.slug]).toBe(article);
    expect(article.slug).toBe("do-you-need-a-gpu-to-run-an-ai-agent");
  });

  it("answers the target query and links the required decision paths", () => {
    const copy = JSON.stringify(article);

    expect(article.metaTitle).toContain("Need a GPU");
    expect(article.faqs).toHaveLength(6);
    expect(copy).toContain("/pricing");
    expect(copy).toContain("/agents/codex");
    expect(copy).toContain("API-based");
    expect(copy).toContain("local inference");
  });

  it("keeps the operator voice guardrails", () => {
    const copy = JSON.stringify(article);

    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\b(?:seamless|robust|unlock|leverage|transform)\b/i);
    expect(copy).not.toMatch(/it's not just .+ it's /i);
  });
});
