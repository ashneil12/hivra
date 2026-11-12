import { MANAGED_AGENTS_GUIDE_SLUG, isManagedAgentsGuideEnabled } from "../managed-agents-guide-flag";
import { article } from "../articles/run-managed-agents-on-your-own-computer";

describe("managed agents guide switch", () => {
  it("is off unless set to 1 or true", () => {
    expect(isManagedAgentsGuideEnabled("")).toBe(false);
    expect(isManagedAgentsGuideEnabled("0")).toBe(false);
    expect(isManagedAgentsGuideEnabled("1")).toBe(true);
    expect(isManagedAgentsGuideEnabled(" TRUE ")).toBe(true);
  });

  it("keeps the guide out of the blog while off", () => {
    jest.isolateModules(() => {
      const previous = process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE;
      delete process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE;
      try {
        const { BLOG_ARTICLES } = jest.requireActual("@/lib/blog-data");
        const { BLOG_TOPICS } = jest.requireActual("../topics");
        expect(BLOG_ARTICLES[MANAGED_AGENTS_GUIDE_SLUG]).toBeUndefined();
        expect(BLOG_TOPICS.flatMap((topic: { articles: readonly string[] }) => topic.articles)).not.toContain(MANAGED_AGENTS_GUIDE_SLUG);
      } finally {
        if (previous !== undefined) process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE = previous;
      }
    });
  });

  it("registers the guide in one topic when on", () => {
    jest.isolateModules(() => {
      const previous = process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE;
      process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE = "1";
      try {
        const { BLOG_ARTICLES } = jest.requireActual("@/lib/blog-data");
        const { topicForArticle } = jest.requireActual("../topics");
        expect(BLOG_ARTICLES[MANAGED_AGENTS_GUIDE_SLUG]?.slug).toBe(MANAGED_AGENTS_GUIDE_SLUG);
        expect(topicForArticle(MANAGED_AGENTS_GUIDE_SLUG)?.slug).toBe("hosting-and-costs");
      } finally {
        if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE;
        else process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE = previous;
      }
    });
  });

  it("does not claim the workers were tested on Hivra and carries the non-affiliation line", () => {
    const copy = JSON.stringify(article);
    expect(copy).toMatch(/still testing both workers on Hivra computers/);
    expect(copy).toMatch(/not affiliated with Anthropic or Google/);
    expect(copy).not.toMatch(/[–—]/);
  });
});
