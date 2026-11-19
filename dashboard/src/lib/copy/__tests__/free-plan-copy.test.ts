import { forFreePlanState, withoutFreeAccount } from "../free-plan-copy";

describe("withoutFreeAccount", () => {
  it("drops sentences about a free account and keeps the rest", () => {
    expect(withoutFreeAccount("Every Hivra Cloud computer needs a paid plan. A free Hivra account works with a server you connect yourself. See pricing."))
      .toBe("Every Hivra Cloud computer needs a paid plan. See pricing.");
  });

  it("rewrites a mention that is not a sentence, such as a heading", () => {
    expect(withoutFreeAccount("What a free account can do with it")).toBe("What your account can do with it");
  });

  it("stays inside a table cell", () => {
    expect(withoutFreeAccount("| A paid plan | A server you connect, and a free Hivra account |"))
      .toBe("| A paid plan | A server you connect, and your account |");
  });
});

describe("forFreePlanState", () => {
  const page = { title: "Plans", body: ["A free account works with a server you connect. Plans start at $9.99."], n: 3 };

  it("leaves content unchanged while the Free plan is open", () => {
    expect(forFreePlanState(page, false)).toBe(page);
  });

  it("removes every free-account mention once it is closed", () => {
    const closed = forFreePlanState(page, true);
    expect(JSON.stringify(closed)).not.toMatch(/free (hivra )?account/i);
    expect(closed.n).toBe(3);
  });
});

describe("docs once the Free plan is closed", () => {
  it("no docs page mentions a free account", () => {
    jest.isolateModules(() => {
      process.env.HIVRA_FREE_PLAN_CLOSED_AT = "2020-01-01T00:00:00Z";
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DOCS } = require("@/lib/docs/registry");
      expect(JSON.stringify(DOCS)).not.toMatch(/free (hivra )?account/i);
      delete process.env.HIVRA_FREE_PLAN_CLOSED_AT;
    });
  });
});

describe("blog articles once the Free plan is closed", () => {
  it("no article mentions a free account", () => {
    jest.isolateModules(() => {
      process.env.HIVRA_FREE_PLAN_CLOSED_AT = "2020-01-01T00:00:00Z";
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BLOG_ARTICLES } = require("@/lib/blog-data");
      expect(JSON.stringify(BLOG_ARTICLES)).not.toMatch(/free (hivra )?account/i);
      delete process.env.HIVRA_FREE_PLAN_CLOSED_AT;
    });
  });
});
