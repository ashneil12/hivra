import { BLOG_ARTICLES } from "@/lib/blog-data";
import { DOCS } from "@/lib/docs/registry";

describe("public plan copy", () => {
  it("does not tell readers they can sign up for a free Hivra account", () => {
    const unrestrictedFreeClaim =
      /\b(?:a|your) free (?:Hivra )?account\b|\b(?:Hivra )?account (?:is free|(?:itself )?costs nothing)\b|\buse the free account\b/i;
    const allPages = [...Object.values(DOCS), ...Object.values(BLOG_ARTICLES)];

    expect(allPages.filter((page) => unrestrictedFreeClaim.test(JSON.stringify(page))).map((page) => page.slug)).toEqual([]);
  });

  it("distinguishes grandfathering from the options for new accounts", () => {
    const faq = DOCS["plans-and-billing"].faqs?.find(({ q }) => q.includes("Free is closed"));

    expect(faq?.a).toContain("existing Free accounts keep their access.");
    expect(faq?.a).toContain("New accounts need a plan or an eligible trial");
  });
});
