import { BLOG_ARTICLES } from "@/lib/blog-data";
import { article } from "../articles/control-claude-code-from-telegram";

describe("Claude Code Telegram article", () => {
  it("is registered under its canonical slug", () => {
    expect(BLOG_ARTICLES[article.slug]).toBe(article);
    expect(article.slug).toBe("control-claude-code-from-telegram");
  });

  it("answers the target query and links the required decision paths", () => {
    const copy = JSON.stringify(article);

    expect(article.metaTitle).toContain("Claude Code From Telegram");
    expect(article.faqs).toHaveLength(6);
    expect(copy).toContain("telegram@claude-plugins-official");
    expect(copy).toContain("--channels");
    expect(copy).toContain("/telegram:access policy allowlist");
    expect(copy).toContain("/agents/claude-code");
    expect(copy).toContain("/pricing");
  });

  it("states the host and product boundaries", () => {
    const copy = JSON.stringify(article);

    expect(copy).toContain("machine and the Claude Code process must stay online");
    // A Claude Code agent on Hivra ships its own Telegram connect (the Telegram
    // tab under Manage, HivraTelegram.tsx); the plugin is the self-hosted route.
    expect(copy).toContain("On Hivra, a Claude Code agent also has its own Telegram connect, in its Telegram tab under Manage");
    expect(copy).toContain("messages to the bot run as work on the computer");
    expect(copy).not.toMatch(/\bthe box\b|Claude Code box/);
    expect(copy).toContain("the route when you host Claude Code yourself");
    expect(copy).not.toMatch(/does not claim a built-in Telegram connection|No built-in Hivra Telegram connection/);
    expect(copy).toContain("research preview");
    expect(copy).toContain("not affiliated with Anthropic");
  });

  it("keeps only Channels facts Anthropic's current documentation states", () => {
    const copy = JSON.stringify(article);

    // The minimum version is not pinned in the post: Anthropic's page no longer
    // states one, so the post defers to the documentation instead.
    expect(copy).not.toMatch(/2\.1\.80/);
    expect(copy).toContain("claude.ai authentication or an Anthropic Console API key");
    expect(copy).toContain("~/.claude/channels/telegram/.env");
    expect(copy).toContain("/plugin marketplace add anthropics/claude-plugins-official");
  });

  it("keeps the operator voice guardrails", () => {
    const copy = JSON.stringify(article);

    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\b(?:seamless|robust|unlock|leverage|transform)\b/i);
    expect(copy).not.toMatch(/it's not just .+ it's /i);
  });
});
