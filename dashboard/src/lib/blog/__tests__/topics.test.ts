import { BLOG_ARTICLES, BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { BLOG_TOPICS, topicAnchor, topicForArticle } from "../topics";

describe("blog topics", () => {
  it("place every article in exactly one topic", () => {
    const seen = new Map<string, string>();
    for (const topic of BLOG_TOPICS) {
      for (const slug of topic.articles) {
        expect({ slug, topic: topic.slug, alsoIn: seen.get(slug) }).toEqual({ slug, topic: topic.slug, alsoIn: undefined });
        seen.set(slug, topic.slug);
      }
    }
    const missing = BLOG_ARTICLES_LIST.map((article) => article.slug).filter((slug) => !seen.has(slug));
    expect(missing).toEqual([]);
  });

  it("only name articles that exist", () => {
    for (const topic of BLOG_TOPICS) for (const slug of topic.articles) expect(BLOG_ARTICLES[slug]).toBeDefined();
  });

  it("have unique anchors and plain, dash-free copy", () => {
    const anchors = BLOG_TOPICS.map(topicAnchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const topic of BLOG_TOPICS) {
      expect(`${topic.title} ${topic.blurb}`).not.toMatch(/[–—]/);
      expect(topic.blurb.length).toBeGreaterThan(40);
    }
  });

  it("finds an article's topic", () => {
    expect(topicForArticle("keep-claude-code-running-24-7")?.slug).toBe("keep-agents-running");
    expect(topicForArticle("does-not-exist")).toBeUndefined();
  });
});
