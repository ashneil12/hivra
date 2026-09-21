/**
 * Warm-pool campaign email content tests. Locks in:
 *   - subject, complete text/html, and the ?from=warm_pool billing CTA
 *   - the voice rules (no exclamation points, no hype words, signed
 *     "— Ash / Founder, Hivra")
 *   - the three Pro capabilities each carry a concrete example
 *   - real prices and the honest close
 *   - send() fails soft when Resend isn't configured
 */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  WARM_POOL_EMAIL_KEY,
  buildWarmPoolEmail,
  sendWarmPoolEmail,
} from "@/lib/email/warm-pool-campaign";

describe("buildWarmPoolEmail", () => {
  it("builds the subject, text, html and CTA", () => {
    const content = buildWarmPoolEmail({ firstName: "Sam" });
    expect(content.subject).toBe("what your agent could be doing");
    expect(content.ctaUrl).toBe("https://hivra.cloud/dashboard/billing?from=warm_pool");
    expect(content.html).toContain("<!doctype html>");
    expect(content.html).toContain(content.ctaUrl);
    expect(content.text).toContain(content.ctaUrl);
  });

  it("never uses exclamation points or hype words", () => {
    const { subject, text, html } = buildWarmPoolEmail({ firstName: "Sam" });
    expect(subject).not.toContain("!");
    expect(text).not.toContain("!");
    const all = `${subject}\n${text}\n${html}`;
    expect(all).not.toMatch(/unlock|supercharge|game-?chang|revolutioniz|seamless/i);
    expect(all).not.toMatch(/hope this finds you well/i);
  });

  it("is signed '— Ash / Founder, Hivra'", () => {
    const { text } = buildWarmPoolEmail({});
    expect(text).toContain("— Ash");
    expect(text).toContain("Founder, Hivra");
  });

  it("pitches the three Pro capabilities with concrete examples", () => {
    const { text } = buildWarmPoolEmail({});
    expect(text).toMatch(/web browsing/i);
    expect(text).toMatch(/persistent memory/i);
    expect(text).toMatch(/scheduled tasks/i);
    // Each capability carries a worked example, not just a label.
    expect(text).toContain("Watch this product's price");
    expect(text).toContain("bullet points");
    expect(text).toContain("Every Monday at 9");
  });

  it("states the real prices and the honest close", () => {
    const { text } = buildWarmPoolEmail({});
    expect(text).toContain("$9.99/mo");
    expect(text).toContain("$79/yr");
    expect(text).toContain("If free covers you, ignore this — it stays free.");
  });

  it("personalizes the greeting and falls back cleanly", () => {
    expect(buildWarmPoolEmail({ firstName: "Sam" }).text).toContain("Hey Sam,");
    expect(buildWarmPoolEmail({}).text).toContain("Hey,");
    expect(buildWarmPoolEmail({ firstName: "  " }).text).toContain("Hey,");
  });

  it("exports the dated ledger key", () => {
    expect(WARM_POOL_EMAIL_KEY).toBe("warm_pool_2026_06");
  });
});

describe("sendWarmPoolEmail", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails soft when RESEND_API_KEY is missing", async () => {
    const res = await sendWarmPoolEmail({
      email: "user@example.com",
      firstName: "Sam",
      idempotencyKey: "warm_pool_2026_06_user_1",
    });
    expect(res).toEqual({ sent: false, reason: "not_configured" });
  });
});
