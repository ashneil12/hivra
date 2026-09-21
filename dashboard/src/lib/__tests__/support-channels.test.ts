/**
 * support-channels — locks the canonical support channels and the prefilled
 * mailto: builder used by ReportProblemLink on dashboard dead-ends.
 */

import {
  SUPPORT_DISCORD_URL,
  SUPPORT_EMAIL,
  buildSupportMailto,
} from "@/lib/support-channels";

describe("support-channels", () => {
  it("exposes the canonical Discord + email channels", () => {
    expect(SUPPORT_DISCORD_URL).toBe("https://discord.gg/tDQZq8479F");
    expect(SUPPORT_EMAIL).toBe("info@hermesos.cloud");
  });

  it("builds a mailto: to the support inbox with a [Report] subject", () => {
    const href = buildSupportMailto({ summary: "Agent failed to start" });
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get("subject")).toBe("[Report] Agent failed to start");
  });

  it("embeds the instance id and error context in the body", () => {
    const href = buildSupportMailto({
      summary: "Checkout not confirmed",
      instanceId: "inst-123",
      errorContext: "Stripe webhook timed out",
    });
    const body = new URLSearchParams(href.split("?")[1]).get("body") ?? "";
    expect(body).toContain("Agent: inst-123");
    expect(body).toContain("Error: Stripe webhook timed out");
  });

  it("omits diagnostics lines when no context is supplied", () => {
    const body =
      new URLSearchParams(buildSupportMailto({ summary: "X" }).split("?")[1]).get("body") ?? "";
    expect(body).not.toContain("Agent:");
    expect(body).not.toContain("Error:");
  });
});
