// Venice onboarding links shared by /venice and Launch's AI connection step.
//
// Safe for client and server code: plain constants and pure builders.
// NEXT_PUBLIC_HIVRA_SETUP_CALL_URL is read with a literal key so Next inlines
// it into client bundles; when it is unset, "Book a setup call" opens a
// prefilled email to the support inbox instead.

import { SUPPORT_DISCORD_URL, SUPPORT_EMAIL } from "@/lib/support-channels";

/** Where a Venice account owner creates an API key. */
export const VENICE_API_KEYS_URL = "https://venice.ai/settings/api";

/** Venice's own docs, for questions about a Venice account or its billing. */
export const VENICE_DOCS_URL = "https://docs.venice.ai";

export { SUPPORT_DISCORD_URL };

export type SetupCallLink = { href: string; external: boolean };

function setupCallUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_HIVRA_SETUP_CALL_URL?.trim() ?? "";
  return /^https:\/\/\S+$/.test(value) ? value : null;
}

/** The "Book a setup call" link: the booking page when one is set, otherwise
 * an email asking for a call, with the agent named when we know it. */
export function veniceSetupCallLink(agentName?: string | null): SetupCallLink {
  const booking = setupCallUrl();
  if (booking) return { href: booking, external: true };
  const agent = agentName?.trim();
  const params = new URLSearchParams({
    subject: "Setup call: running my agent on Venice",
    body: [
      `I'd like help getting ${agent ? agent : "my agent"} running on Venice with Hivra.`,
      "",
      "I'm using: Hivra credits / my own Venice API key (delete one)",
      "Times that suit me (with time zone):",
      "",
    ].join("\n"),
  });
  return { href: `mailto:${SUPPORT_EMAIL}?${params.toString()}`, external: false };
}
