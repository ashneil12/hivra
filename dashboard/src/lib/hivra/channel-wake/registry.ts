// Every channel a wake can cover, in one place, and the host-side checks
// generated from it. Pure (no server imports): the sleep scripts read it.
//
// Telegram is the first entry. Its server side is the telegram-wake module,
// unchanged, and its host check is the same expression the Telegram-only gate
// has always used. Every other channel is a generic spec: Matrix, email and
// Discord. A generic spec only acts when the channel wake switches
// are on and the owner opted in; a Telegram-only sleep never reads this list,
// so its scripts are unchanged.
//
// The TypeScript allowlist (CHANNEL_WAKE_COVERABLE) and the Perl allowlist in
// the generated host gate are built from the same arrays, so they cannot drift.

import { isChannelWakeChannel, type ChannelWakeChannel } from "./config";
import type { ChannelCoverageInput, ChannelWakeSpec } from "./types";

const FINGERPRINT = /^[0-9a-f]{16}$/;
const PROBE_TAG = /^[a-z]+:[a-z][a-z0-9_]{0,31}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Telegram, as the gates see it. Its coverage rules live in telegram-wake/coverage.ts. */
export const TELEGRAM_CHANNEL_SPEC = {
  channel: "telegram",
  probeTag: "hermes:telegram",
  detector: "server-push",
  catchUp: "native",
  needsServerDisarm: true,
  socketBased: true,
  credKeys: ["TELEGRAM_BOT_TOKEN"],
} as const satisfies Omit<ChannelWakeSpec, "coverageBlockers" | "hostFactsPerl">;

/**
 * Telegram's host check: the probe's Telegram facts match what the server
 * checked. The token is in .env with the fingerprint in $fp, Hermes polls,
 * and config.yaml has no token of its own. Reads $fp and $tg.
 */
export const TELEGRAM_HOST_CHECK_PERL = String.raw`$fp =~ /\A[0-9a-f]{16}\z/ && ref($tg) eq "HASH"
    && defined($tg->{hermesFp}) && !ref($tg->{hermesFp}) && $tg->{hermesFp} eq $fp
    && JSON::PP::is_bool($tg->{hermesTokenInEnv}) && $tg->{hermesTokenInEnv}
    && JSON::PP::is_bool($tg->{hermesWebhookMode}) && !$tg->{hermesWebhookMode}
    && JSON::PP::is_bool($tg->{hermesConfigToken}) && !$tg->{hermesConfigToken}`;

/**
 * Matrix, through a homeserver pusher registered once at opt-in (WP10). The
 * homeserver calls Hivra's push gateway route on a DM or a mention; nothing is
 * armed at sleep and nothing is taken down at wake. Hermes catches up with
 * /sync from its saved token. Covered only while the probe sees the same
 * homeserver and access token as at opt-in (a password login has no token,
 * so it is never covered).
 */
export const MATRIX_CHANNEL_SPEC: ChannelWakeSpec = {
  channel: "matrix",
  probeTag: "hermes:matrix",
  detector: "server-push",
  catchUp: "native",
  needsServerDisarm: false,
  socketBased: true,
  credKeys: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"],
  coverageBlockers(input: ChannelCoverageInput): string[] {
    const reasons = standardChannelBlockers(MATRIX_CHANNEL_SPEC, input);
    const facts = input.probe?.channelFacts?.matrix;
    if (!facts) reasons.push("no_matrix_facts");
    else {
      if (!facts.homeserverHost) reasons.push("no_homeserver");
      if (facts.passwordLogin !== false) reasons.push("password_login");
    }
    return reasons;
  },
  hostFactsPerl: `defined($f) && defined($f->{homeserverHost}) && !ref($f->{homeserverHost}) && $f->{homeserverHost} ne ""
        && JSON::PP::is_bool($f->{passwordLogin}) && !$f->{passwordLogin}`,
};

/**
 * Email, through the host wake doorbell (WP11): before the stop, the arm host
 * script reads the mail settings inside the computer and hands them to the
 * doorbell on the host, which records the INBOX baseline and watches it
 * read-only while the agent sleeps. A message from a sender Hermes would
 * answer asks Hivra for the wake. Hermes catches up by itself (it searches
 * UNSEEN on every poll). Covered only while the probe sees the same address,
 * password and IMAP host as at opt-in, and an IMAP host at all. The doorbell
 * switch (HIVRA_WAKE_DOORBELLS) is checked by the adapter.
 */
export const EMAIL_CHANNEL_SPEC: ChannelWakeSpec = {
  channel: "email",
  probeTag: "hermes:email",
  detector: "host-doorbell",
  catchUp: "native",
  needsServerDisarm: false,
  socketBased: false,
  credKeys: ["EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST"],
  coverageBlockers(input: ChannelCoverageInput): string[] {
    const reasons = standardChannelBlockers(EMAIL_CHANNEL_SPEC, input);
    const facts = input.probe?.channelFacts?.email;
    if (!facts) reasons.push("no_email_facts");
    else if (!facts.imapHost) reasons.push("no_imap_host");
    return reasons;
  },
  hostFactsPerl: `defined($f) && defined($f->{imapHost}) && !ref($f->{imapHost}) && $f->{imapHost} ne ""`,
};

/**
 * Discord, through the host wake doorbell (WP12): before the stop, the arm
 * host script reads the bot token and Hermes's reply settings inside the
 * computer and hands them to the doorbell, which opens its own gateway session
 * and answers once Discord said READY. A DM, a mention, a reply to the bot or a
 * message in a free-response channel asks Hivra for the wake.
 *
 * The message that woke the agent reaches Hermes only through Discord's
 * replay (a short nap) or Hermes's own catch-up (DISCORD_MISSED_MESSAGE_BACKFILL,
 * off by default), and that catch-up reads DMs only from channels it lists.
 * So it is covered only while the probe sees the catch-up on and, as Hermes
 * always accepts DMs, at least one channel listed for it. OpenClaw's Discord
 * (openclaw:discord) has no catch-up and is never covered. The doorbell switch
 * (HIVRA_WAKE_DOORBELLS) is checked by the adapter.
 */
export const DISCORD_CHANNEL_SPEC: ChannelWakeSpec = {
  channel: "discord",
  probeTag: "hermes:discord",
  detector: "host-doorbell",
  catchUp: "needs-config:DISCORD_MISSED_MESSAGE_BACKFILL",
  needsServerDisarm: false,
  socketBased: true,
  credKeys: ["DISCORD_BOT_TOKEN"],
  coverageBlockers(input: ChannelCoverageInput): string[] {
    const reasons = standardChannelBlockers(DISCORD_CHANNEL_SPEC, input);
    const facts = input.probe?.channelFacts?.discord;
    if (!facts) reasons.push("no_discord_facts");
    else {
      if (!facts.backfill) reasons.push("backfill_off");
      if (facts.dmsAllowed && facts.backfillChannels === 0) reasons.push("dm_not_backfilled");
    }
    return reasons;
  },
  hostFactsPerl: String.raw`defined($f) && JSON::PP::is_bool($f->{backfill}) && $f->{backfill}
        && JSON::PP::is_bool($f->{dmsAllowed}) && defined($f->{backfillChannels}) && !ref($f->{backfillChannels})
        && $f->{backfillChannels} =~ /\A[0-9]{1,6}\z/ && (!$f->{dmsAllowed} || $f->{backfillChannels} > 0)`,
};

/** The channels with a generic adapter; order is the gate's order. */
export const GENERIC_CHANNEL_SPECS: readonly ChannelWakeSpec[] = [MATRIX_CHANNEL_SPEC, EMAIL_CHANNEL_SPEC, DISCORD_CHANNEL_SPEC];

/** Every probe tag a wake can ever cover. Both gates refuse anything else. */
export function coverableProbeTags(specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS): string[] {
  return [TELEGRAM_CHANNEL_SPEC.probeTag, ...specs.map((spec) => spec.probeTag)];
}

export const CHANNEL_WAKE_COVERABLE: readonly string[] = coverableProbeTags();

/** The generic spec for a channel, or null (Telegram and unknown names have none). */
export function genericChannelSpec(
  channel: unknown,
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): ChannelWakeSpec | null {
  return specs.find((spec) => spec.channel === channel) ?? null;
}

/** The channel a probe tag belongs to, or null. */
export function channelForProbeTag(
  tag: string,
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): ChannelWakeChannel | null {
  if (tag === TELEGRAM_CHANNEL_SPEC.probeTag) return "telegram";
  return specs.find((spec) => spec.probeTag === tag)?.channel ?? null;
}

/** Keeps only names on the allowlist, once each. */
export function allowedCoveredChannels(
  channels: readonly unknown[] | undefined,
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): string[] {
  const allowed = coverableProbeTags(specs);
  const out: string[] = [];
  for (const channel of channels ?? []) {
    if (typeof channel === "string" && allowed.includes(channel) && !out.includes(channel)) out.push(channel);
  }
  return out;
}

/**
 * The reasons every generic adapter shares: the switches, the owner's opt-in,
 * a block, and the credential fingerprint the probe saw against the one taken
 * at opt-in. An adapter adds its own on top. Empty means covered.
 */
export function standardChannelBlockers(spec: Pick<ChannelWakeSpec, "channel" | "probeTag">, input: ChannelCoverageInput): string[] {
  const reasons: string[] = [];
  if (!input.acts) reasons.push("not_configured");
  const row = input.row;
  if (!row || row.enabled !== true) reasons.push("not_opted_in");
  else {
    if (!row.credFp || !FINGERPRINT.test(row.credFp)) reasons.push("no_fingerprint");
    if (row.blockedUntil) {
      const until = Date.parse(row.blockedUntil);
      if (!Number.isFinite(until) || until > input.nowMs) reasons.push("blocked");
    }
  }
  const probe = input.probe;
  if (!probe) {
    reasons.push("no_probe");
    return reasons;
  }
  if (!probe.liveChannels.includes(spec.probeTag)) reasons.push("not_live");
  const seen = probe.channelFps?.[spec.channel];
  if (typeof seen !== "string" || !FINGERPRINT.test(seen)) reasons.push("no_probe_fingerprint");
  else if (!row?.credFp || seen !== row.credFp) reasons.push("credential_changed");
  return reasons;
}

function assertSpecs(specs: readonly ChannelWakeSpec[]): void {
  const seen = new Set<string>([TELEGRAM_CHANNEL_SPEC.channel]);
  for (const spec of specs) {
    if (!isChannelWakeChannel(spec.channel) || seen.has(spec.channel)) throw new Error("Invalid channel wake spec.");
    if (!PROBE_TAG.test(spec.probeTag) || spec.probeTag === TELEGRAM_CHANNEL_SPEC.probeTag) throw new Error("Invalid channel wake spec.");
    if (spec.credKeys.length === 0 || !spec.credKeys.every((key) => ENV_KEY.test(key))) throw new Error("Invalid channel wake spec.");
    if (typeof spec.hostFactsPerl !== "string" || spec.hostFactsPerl.trim() === "" || /HIVRA_|\0/.test(spec.hostFactsPerl)) {
      throw new Error("Invalid channel wake spec.");
    }
    seen.add(spec.channel);
  }
}

/**
 * The host gate for a sleep that covers channels through more than Telegram.
 * A live channel keeps the agent awake unless it is on the allowlist, named in
 * HIVRA_COVERED_CHANNELS, and its own check passes: Telegram's facts for
 * Telegram ($tg_ok applies to Telegram only), and for every other channel the
 * credential fingerprint the probe saw equals the one in HIVRA_CHANNEL_FPS,
 * plus that adapter's own facts check.
 */
export function channelGatePerl(specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS): string {
  assertSpecs(specs);
  const tags = coverableProbeTags(specs).map((tag) => JSON.stringify(tag)).join(", ");
  const blocks = specs.map((spec) => {
    const name = JSON.stringify(spec.channel);
    return `{
    my $fp = $fps{${name}} // "";
    my $seen = $cfps->{${name}};
    my $f = ref($cfacts->{${name}}) eq "HASH" ? $cfacts->{${name}} : undef;
    $ok{${JSON.stringify(spec.probeTag)}} = ($fp =~ /\\A[0-9a-f]{16}\\z/ && defined($seen) && !ref($seen) && $seen eq $fp
        && (${spec.hostFactsPerl})) ? 1 : 0;
}`;
  });
  return [
    `my %allowed = map { $_ => 1 } (${tags});`,
    `my %covered = map { $_ => 1 } grep { $allowed{$_} } split /,/, ($ENV{HIVRA_COVERED_CHANNELS} // "");`,
    `my %fps;`,
    `for my $pair (split /,/, ($ENV{HIVRA_CHANNEL_FPS} // "")) {`,
    `    my ($k, $v) = split /:/, $pair, 2;`,
    `    $fps{$k} = $v if defined($k) && defined($v) && $v =~ /\\A[0-9a-f]{16}\\z/;`,
    `}`,
    `my $cfps = ref($d->{channelFps}) eq "HASH" ? $d->{channelFps} : {};`,
    `my $cfacts = ref($d->{channelFacts}) eq "HASH" ? $d->{channelFacts} : {};`,
    `my %ok;`,
    `{`,
    `    my $fp = $fps{"telegram"} // "";`,
    `    my $tg = $d->{telegram};`,
    `    $ok{"hermes:telegram"} = (${TELEGRAM_HOST_CHECK_PERL}) ? 1 : 0;`,
    `}`,
    ...blocks,
    `for my $c (@$channels) {`,
    `    $busy = 1 unless defined($c) && !ref($c) && $covered{$c} && $ok{$c};`,
    `}`,
  ].join("\n");
}

/**
 * The probe's extra lines for the channels asked about: each channel's
 * credential fingerprint (the first 16 hex of the sha256 of its .env values
 * joined by a newline), or None when any value is missing. Never a value.
 * Runs inside the idle probe, where env, env_value and OUT exist.
 */
export function channelFpsPython(
  channels: readonly ChannelWakeChannel[],
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): string {
  assertSpecs(specs);
  const entries = channels.map((channel) => {
    const spec = genericChannelSpec(channel, specs);
    if (!spec) throw new Error("No generic channel wake spec.");
    return `${JSON.stringify(channel)}: chan_fp(${JSON.stringify(spec.credKeys)})`;
  });
  return String.raw`# Channel wake facts: a fingerprint of each channel's credential, never the credential.
import hashlib
def chan_fp(keys):
    vals = [env_value(env, k) or "" for k in keys]
    return hashlib.sha256("\n".join(vals).encode("utf-8")).hexdigest()[:16] if all(vals) else None
OUT["channelFps"] = {${entries.join(", ")}}
`;
}

/** Validates a fingerprint map entry list into HIVRA_CHANNEL_FPS form: "chan:fp,chan:fp". */
export function channelFpsEnv(fingerprints: Partial<Record<ChannelWakeChannel, string>>): string {
  const parts: string[] = [];
  for (const [channel, fp] of Object.entries(fingerprints)) {
    if (!isChannelWakeChannel(channel) || typeof fp !== "string" || !FINGERPRINT.test(fp)) throw new Error("Invalid channel fingerprint.");
    parts.push(`${channel}:${fp}`);
  }
  return parts.sort().join(",");
}
