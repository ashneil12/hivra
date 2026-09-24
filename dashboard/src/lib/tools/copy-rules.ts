// Claims the public /tools pages must never make, as of the owner's pricing
// decision of 2026-09-14 and what checkout sells today. The tests in
// lib/tools, components/tools and app/tools scan every copy string and every
// rendered page against this list.
//
// Each rule names why it exists so a failing test says what to fix.

export interface BannedClaim {
  pattern: RegExp;
  why: string;
}

export const BANNED_CLAIMS: BannedClaim[] = [
  { pattern: /free trial|trial period|7-day trial|\btrial\b/i, why: "No plan has a trial (plans.ts trialDays 0)." },
  { pattern: /card required|no card|credit card required|no credit card/i, why: "No card or no-card trial claims." },
  { pattern: /never sleeps|never log(?:s)? off|never paused(?! for inactivity)/i, why: "Only paid plans stay on; say 'not paused for inactivity'." },
  { pattern: /free tier|free plan|starts at \$0|\$0 for one agent/i, why: "Do not advertise a hosted Free plan." },
  { pattern: /unlimited agents|up to \d+ (?:active |always-on )?agents|\d+ agents? (?:included|per plan)/i, why: "No agent-count limits or unlimited claims." },
  { pattern: /\bWindows\b/, why: "Windows computers are not generally available." },
  { pattern: /\bclones?\b|snapshots? (?:on|included)/i, why: "Snapshots and clones are not shipped." },
  { pattern: /nightly backups?|guaranteed backups?|automatic backups? included/i, why: "Backups are not guaranteed." },
  { pattern: /multi-agent coordination|orchestrat/i, why: "Built-in multi-agent coordination is not shipped." },
  { pattern: /cannot read your|can't read your|never see(?:s)? your (?:conversations|data)/i, why: "No absolute privacy claims without evidence." },
  { pattern: /desktop app/i, why: "Desktop apps are not available." },
  { pattern: /deploy in \d|in \d+ minutes|live in minutes|in minutes\b|one[- ]click|instantly/i, why: "No unmeasured speed claims." },
  { pattern: /bring your own cloud|BYO cloud|your own (?:AWS|GCP|Azure|DigitalOcean) account/i, why: "BYO cloud beyond Hetzner is not available." },
  // $19.99 is allowed only with its size in the same sentence ("$19.99 a month for 4 vCPU and 8 GB").
  { pattern: /\bHivra (?:Pro|Power|Starter|Studio|Max)\b|\bPower plan\b|Pro is \$9\.99|\$19\.99(?![^.]*4 vCPU and 8 GB)/i, why: "Describe Hivra plans by price and size, not by colliding names." },
  { pattern: /sizes (?:are )?(?:on|listed on) the pricing page|current (?:caps|sizes)/i, why: "The /pricing page shows a preview ladder; state the $9.99 and $19.99 sizes inline." },
  {
    pattern: /no SIGHUP|no tmux (?:required|needed)|survives? (?:laptop|lid) (?:sleep|close)|close your laptop\. it keeps/i,
    why: "Claude Code and Codex runs started in Hivra's browser chat or agent terminal stop when that tab closes; only tmux or Telegram runs keep going.",
  },
  { pattern: /\$79\b|\$149\b|\/yr\b|per year|yearly plan/i, why: "Do not state a Hivra annual price." },
  { pattern: /[–—]/, why: "No em or en dashes in copy." },
];

/** Every banned claim a piece of copy makes, with the reason. */
export function findBannedClaims(text: string): { match: string; why: string }[] {
  const hits: { match: string; why: string }[] = [];
  for (const { pattern, why } of BANNED_CLAIMS) {
    const match = pattern.exec(text);
    if (match) hits.push({ match: match[0], why });
  }
  return hits;
}
