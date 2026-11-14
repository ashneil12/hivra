import { BLOG_ARTICLES } from "@/lib/blog-data";
import { topicForArticle } from "../topics";
import { article } from "../articles/run-managed-agents-on-your-own-computer";

const SLUG = "run-managed-agents-on-your-own-computer";

describe("managed agents guide", () => {
  it("is registered in the hosting topic", () => {
    expect(BLOG_ARTICLES[SLUG]?.slug).toBe(SLUG);
    expect(topicForArticle(SLUG)?.slug).toBe("hosting-and-costs");
  });

  it("does not claim the workers were tested on Hivra and carries the non-affiliation line", () => {
    const copy = JSON.stringify(article);
    expect(copy).toMatch(/still testing both workers on Hivra computers/);
    expect(copy).toMatch(/not affiliated with Anthropic or Google/);
    expect(copy).not.toMatch(/[–—]/);
  });
});
