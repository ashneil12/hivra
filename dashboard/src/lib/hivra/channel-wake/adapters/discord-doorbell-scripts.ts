// The Discord doorbell's pure half: the guest program that reads the bot
// token and Hermes's reply settings, the host script that hands them to the
// doorbell, and the parser for its answer. Nothing here talks to the network
// or the database.
//
// Credentials. The arm host script reads ~/.hermes/.env through the
// vmid-bound guest exec and pipes the answer straight into the doorbell on
// the same host (hivra-wake-doorbell.py arm-from-guest ... discord). It is
// never printed, so the token never reaches Hivra's servers, its logs or its
// database. Hivra only sees the doorbell's answer: ok, and the bot's login
// budget left.

import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildChannelCredReadProgram, buildGuestCredHandoffHostScript, parseIdleProbeRefusal } from "@/lib/hivra/agent-sleep-scripts";
import { DISCORD_CHANNEL_SPEC } from "../registry";
import { DOORBELL_ARM_PREFIX, DOORBELL_SCRIPT, DOORBELL_UNIT, doorbellAnswerLine } from "../doorbell-scripts";

export const DISCORD_CRED_PREFIX = "HIVRA_DISCORD_CRED ";
export const DISCORD_CRED_NONE_PREFIX = "HIVRA_DISCORD_CRED_NONE ";

/** Every ~/.hermes/.env key the doorbell needs to wake the way Hermes answers. */
export const DISCORD_DOORBELL_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_REQUIRE_MENTION",
  "DISCORD_THREAD_REQUIRE_MENTION",
  "DISCORD_ALLOW_BOTS",
  "DISCORD_FREE_RESPONSE_CHANNELS",
] as const;

/**
 * Hermes also takes these reply rules from config.yaml's discord: block. The
 * host cannot read YAML exactly, so when that block sets any of them the
 * doorbell wakes on every guild message (one wake too many, never one too few).
 */
const DISCORD_YAML_GATES_PY = String.raw`# Reply rules config.yaml sets for Discord: the host cannot read them exactly, so every guild message wakes.
try:
    fd = os.open("/home/bux/.hermes/config.yaml", os.O_RDONLY | os.O_NOFOLLOW)
    try: cfg = os.read(fd, 262144).decode("utf-8", "replace")
    finally: os.close(fd)
except OSError:
    cfg = ""
blk = re.search(r"^discord:[ \t]*(\{.*|\n(?:(?:[ \t]+.*)?\n)*)", cfg + "\n", re.M)
if blk and re.search(r"(require_mention|free_response_channels|allow_bots)\s*:", blk.group(1)):
    values["_yaml_gates"] = "1"`;

/** The guest program: the Discord settings and the probe's fingerprint of the token, for the doorbell only. */
export const DISCORD_CRED_READ_PROGRAM = buildChannelCredReadProgram({
  fpKeys: DISCORD_CHANNEL_SPEC.credKeys,
  keys: DISCORD_DOORBELL_KEYS,
  prefix: DISCORD_CRED_PREFIX,
  nonePrefix: DISCORD_CRED_NONE_PREFIX,
  extraPython: DISCORD_YAML_GATES_PY,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const REASON = /^[a-z0-9_]{1,40}$/;

/**
 * Arms the Discord doorbell for one computer, while it is still plainly
 * running: reads the settings in the guest, checks the token is the one the
 * owner opted in with (fingerprint), and hands them to the doorbell, which
 * answers once its own gateway session is READY. Prints one HIVRA_DOORBELL_ARM
 * line (never the token), or one HIVRA_IDLE_REFUSED line.
 */
export function buildDiscordDoorbellArmHostScript(input: {
  vmid: number;
  bindingTag: string | null;
  armId: string;
  credFp: string;
}): string {
  if (!Number.isSafeInteger(input.vmid) || input.vmid < 100 || input.vmid > 999_999_999) throw new Error("Doorbell scripts need a valid vmid.");
  const armId = input.armId.toLowerCase();
  if (!UUID.test(armId) || !FINGERPRINT.test(input.credFp)) throw new Error("Doorbell arm needs an arm id and a fingerprint.");
  return buildGuestCredHandoffHostScript({ vmid: input.vmid, bindingTag: input.bindingTag }, DISCORD_CRED_READ_PROGRAM, {
    preflight: `[ -f ${shellQuote(DOORBELL_SCRIPT)} ] || refuse doorbell_missing
systemctl is-active --quiet ${DOORBELL_UNIT} </dev/null || refuse doorbell_down`,
    command: `/usr/bin/python3 -I -B ${shellQuote(DOORBELL_SCRIPT)} arm-from-guest ${input.vmid} ${shellQuote(armId)} ${shellQuote(input.credFp)} discord`,
  });
}

export type DiscordDoorbellArmResult =
  | { ok: true; loginRemaining: number }
  | { ok: false; reason: string };

/**
 * The doorbell's answer. A doorbell from a release without Discord answers
 * bad_arguments, so the agent stays awake.
 */
export function parseDiscordDoorbellArmOutput(stdout: string, expected: { vmid: number; armId: string }): DiscordDoorbellArmResult {
  const answer = doorbellAnswerLine(stdout, DOORBELL_ARM_PREFIX);
  if (!answer) return { ok: false, reason: parseIdleProbeRefusal(stdout) ?? "no_answer" };
  if (answer.ok !== true) {
    return { ok: false, reason: typeof answer.error === "string" && REASON.test(answer.error) ? answer.error : "refused" };
  }
  const remaining = answer.login_remaining;
  if (answer.vmid !== expected.vmid || answer.arm_id !== expected.armId.toLowerCase() || answer.channel !== "discord"
    || !Number.isSafeInteger(remaining) || (remaining as number) < 0) {
    return { ok: false, reason: "bad_answer" };
  }
  return { ok: true, loginRemaining: remaining as number };
}
