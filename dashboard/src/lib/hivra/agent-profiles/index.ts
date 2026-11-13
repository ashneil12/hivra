// Agent wake profiles: the one place that says, per agent type, what keeps an
// agent awake and how a sleeping one hears its chats. Pure (no server
// imports): the sleep scripts read it.
//
// One switch, off by default:
//   HIVRA_AGENT_PROFILES  off (default) or on
// Off, nothing here is read and every script is exactly as before. On, the
// idle probe gets the profile for the agent's type as data and evaluates it,
// with the chat and CPU safety nets.
//
// With no profile for a type, the probe gets the union of every profile (the
// old fixed lists and more) and no wake source, so no channel of it is ever
// covered, and an unknown chat connection keeps it awake.

import { AGENT_WAKE_PROFILES, COMPUTER_PROFILE } from "./profiles";
import type { ProbeEndpoint } from "./endpoints";
import type {
  ActivityDir,
  AgentWakeProfile,
  CatchUp,
  ChannelSource,
  ChannelWakeSource,
  ProcessMatch,
  ScheduleSource,
  ValueLocation,
  WakePlatform,
} from "./types";

export type * from "./types";
export { AGENT_WAKE_PROFILES, COMPUTER_PROFILE } from "./profiles";

type Env = Record<string, string | undefined>;

export function agentProfilesEnabled(env: Env = process.env): boolean {
  return String(env.HIVRA_AGENT_PROFILES ?? "").trim().toLowerCase() === "on";
}

export function agentWakeProfile(type: unknown): AgentWakeProfile | null {
  return AGENT_WAKE_PROFILES.find((profile) => profile.type === type) ?? null;
}

const TYPE = /^[a-z][a-z0-9-]{0,39}$/;
const PATH = /^(~\/|\/)[A-Za-z0-9._\/-]{0,200}$/;
const TAG = /^[a-z][a-z0-9_-]{0,19}:[a-z][a-z0-9_-]{0,29}$/;
const NAME = /^[a-z][a-z0-9_]{0,29}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const UNIT = /^[a-z][a-z0-9@._-]{0,63}$/;
const WAKE_PLATFORMS: readonly WakePlatform[] = ["telegram", "matrix", "email", "discord"];

function fail(what: string): never {
  throw new Error(`Invalid agent wake profile: ${what}.`);
}
function checkPath(path: unknown): void {
  if (typeof path !== "string" || !PATH.test(path) || path.includes("..") || path.includes("//")) fail("path");
}
function checkPattern(pattern: unknown): void {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 400 || /[\0\n]/.test(pattern)) fail("pattern");
}
function checkMatch(m: ProcessMatch): void {
  const tests = [m.comm, m.cmd, m.cmdAll, m.cgroup].filter((t) => t !== undefined);
  if (tests.length === 0) fail("process match");
  if (m.comm && !m.comm.every((c) => typeof c === "string" && /^[\x21-\x7e]{1,15}$/.test(c))) fail("comm");
  if (m.cmd !== undefined) checkPattern(m.cmd);
  if (m.cgroup !== undefined) checkPattern(m.cgroup);
  if (m.cmdAll && (m.cmdAll.length === 0 || !m.cmdAll.every((c) => typeof c === "string" && c.length > 0 && c.length < 64 && !c.includes("\0")))) fail("cmdAll");
}
function checkLocation(l: ValueLocation): void {
  checkPath(l.path);
  if (l.kind === "env") { if (!KEY.test(l.key)) fail("env key"); }
  else if (l.kind === "json") { if (l.at.length === 0 || !l.at.every((k) => KEY.test(k))) fail("json path"); }
  else if (l.kind === "regex") checkPattern(l.pattern);
  else fail("location kind");
}
function checkCatchUp(c: CatchUp): void {
  if (c.kind === "backfill-setting") checkLocation(c.setting);
  else if (c.kind !== "none" && c.kind !== "server-queued") fail("catch-up");
}
function checkSchedule(s: ScheduleSource): void {
  checkPath(s.path);
  if (s.kind === "hermes-jobs") {
    if ((s.profilesDir === undefined) !== (s.profilePath === undefined)) fail("profiles dir");
    if (s.profilesDir !== undefined) { checkPath(s.profilesDir); checkPath(s.profilePath); }
  } else if (s.kind === "json-next-run" || s.kind === "json-nonempty") {
    if (!KEY.test(s.key)) fail("schedule key");
  } else if (s.kind !== "crontab" && s.kind !== "dir-nonempty") fail("schedule kind");
}
function checkChannel(c: ChannelSource): void {
  if (c.owner) checkMatch(c.owner);
  if ("up" in c && c.up) checkMatch(c.up);
  if (c.kind === "systemd-env" || c.kind === "systemd-active") {
    if (!TAG.test(c.tag) || !NAME.test(c.platform) || !UNIT.test(c.unit)) fail("channel tag");
    if (c.kind === "systemd-env") { checkPath(c.path); if (!KEY.test(c.key)) fail("channel key"); }
    return;
  }
  if (!/^[a-z][a-z0-9_-]{0,19}$/.test(c.prefix)) fail("channel prefix");
  checkPath(c.path);
  if (c.kind === "env-keys") {
    if (c.keys.length === 0 || !c.keys.every(([k, name]) => typeof k === "string" && /^[A-Z][A-Z0-9_()?!]{0,63}$/.test(k) && NAME.test(name))) fail("env keys");
  } else if (c.kind === "gateway-state") {
    if (!c.ignore.every((n) => NAME.test(n))) fail("ignore");
    if ((c.profilesDir === undefined) !== (c.profilePath === undefined)) fail("profiles dir");
    if (c.profilesDir !== undefined) { checkPath(c.profilesDir); checkPath(c.profilePath); }
  } else if (c.kind === "json-channels") {
    if (c.at.length === 0 || !c.at.every((k) => KEY.test(k))) fail("json path");
  } else if (c.kind !== "yaml-enabled") fail("channel kind");
}
function checkWake(platform: string, w: ChannelWakeSource): void {
  if (!WAKE_PLATFORMS.includes(platform as WakePlatform)) fail("wake platform");
  if (!TAG.test(w.tag) || w.tag.split(":")[1] !== platform) fail("wake tag");
  if (w.credential.length === 0) fail("credential");
  w.credential.forEach(checkLocation);
  if (w.credential.some((l) => l.kind === "regex")) fail("credential kind");
  if (w.webhook) checkLocation(w.webhook);
  (w.shadow ?? []).forEach(checkLocation);
  checkCatchUp(w.catchUp);
}

/** Throws unless the profile is well formed. Every registered profile is checked by the tests. */
export function assertAgentWakeProfile(p: AgentWakeProfile): void {
  if (!TYPE.test(p.type)) fail("type");
  p.busy.forEach(checkMatch);
  p.agentProcesses.forEach(checkMatch);
  p.activity.forEach((a: ActivityDir) => {
    checkPath(a.path);
    if (!Number.isInteger(a.depth) || a.depth < 0 || a.depth > 8 || !Number.isInteger(a.budget) || a.budget < 1 || a.budget > 20_000) fail("activity");
  });
  p.schedules.forEach(checkSchedule);
  p.channels.forEach(checkChannel);
  for (const [platform, w] of Object.entries(p.wake)) if (w) checkWake(platform, w);
  if (p.hermesFacts) { checkPath(p.hermesFacts.env); checkPath(p.hermesFacts.config); if (!/^[a-z]+$/.test(p.hermesFacts.prefix)) fail("facts"); }
  if (!p.appPorts.every((n) => Number.isInteger(n) && n > 0 && n < 65536)) fail("port");
}

function uniq<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}

/**
 * The profile the probe evaluates: the computer's own entries merged with the
 * type's. Schedules read the type's first and the computer's last, channels
 * the computer's first: the order the probe always read them in.
 * With no profile, every profile is merged and no wake source is kept.
 */
export function effectiveWakeProfile(type: unknown): AgentWakeProfile {
  const own = agentWakeProfile(type);
  const parts = own ? [own] : AGENT_WAKE_PROFILES;
  return {
    type: own ? own.type : "unknown",
    busy: uniq([...COMPUTER_PROFILE.busy, ...parts.flatMap((p) => p.busy)]),
    agentProcesses: uniq(parts.flatMap((p) => p.agentProcesses)),
    activity: uniq([...COMPUTER_PROFILE.activity, ...parts.flatMap((p) => p.activity)]),
    schedules: uniq([...parts.flatMap((p) => p.schedules), ...COMPUTER_PROFILE.schedules]),
    channels: uniq([...COMPUTER_PROFILE.channels, ...parts.flatMap((p) => p.channels)]),
    wake: own ? { ...own.wake } : {},
    ...(parts.find((p) => p.hermesFacts) ? { hermesFacts: parts.find((p) => p.hermesFacts)!.hermesFacts } : {}),
    appPorts: [...new Set([...COMPUTER_PROFILE.appPorts, ...parts.flatMap((p) => p.appPorts)])].sort((a, b) => a - b),
  };
}

/** Default CPU safety net: a process at or above this share of one core over the sample is busy. */
export const CPU_BUSY_PERCENT = 25;
export const CPU_SAMPLE_MS = 500;

/** What the server hands the probe builder: the merged profile and the safety net inputs. Never a secret. */
export interface ProbeProfile {
  profile: AgentWakeProfile;
  endpoints: readonly ProbeEndpoint[];
  cpu: { pct: number; ms: number } | null;
}

export function probeProfileFor(
  type: unknown,
  options: { endpoints?: readonly ProbeEndpoint[]; cpu?: { pct: number; ms: number } | null } = {},
): ProbeProfile {
  const profile = effectiveWakeProfile(type);
  assertAgentWakeProfile(profile);
  return {
    profile,
    endpoints: options.endpoints ?? [],
    cpu: options.cpu === undefined ? { pct: CPU_BUSY_PERCENT, ms: CPU_SAMPLE_MS } : options.cpu,
  };
}

const ENDPOINT_ADDR = /^(?:[0-9A-F]{8}|[0-9A-F]{32})$/;

/**
 * The probe's input, as one compact JSON object: the profile, plus the wake
 * facts asked for (Telegram's facts, and credential fingerprints per channel,
 * read from where the profile says the credential lives).
 */
export function probeProfileJson(
  input: ProbeProfile,
  ask: { telegram?: boolean; channels?: readonly string[] } = {},
): string {
  const p = input.profile;
  assertAgentWakeProfile(p);
  for (const e of input.endpoints) {
    if (!NAME.test(e.p) || !e.ports.every((n) => Number.isInteger(n) && n > 0 && n < 65536) || !e.a.every((a) => ENDPOINT_ADDR.test(a))) fail("endpoint");
  }
  if (input.cpu && (!(input.cpu.pct > 0 && input.cpu.pct <= 400) || !Number.isInteger(input.cpu.ms) || input.cpu.ms < 50 || input.cpu.ms > 3000)) fail("cpu");
  const out: Record<string, unknown> = {
    v: 1,
    type: p.type,
    busy: p.busy,
    procs: p.agentProcesses,
    activity: p.activity,
    schedules: p.schedules,
    channels: p.channels,
    facts: p.hermesFacts ?? null,
    ports: p.appPorts,
    endpoints: input.endpoints,
    cpu: input.cpu,
  };
  if (ask.telegram === true) {
    const tg = p.wake.telegram;
    // No declared source: the facts say there is no token, so Telegram is never covered.
    out.telegram = tg ? { credential: tg.credential, webhook: tg.webhook ?? null, shadow: tg.shadow ?? [] } : { credential: [], webhook: null, shadow: [] };
  }
  if (ask.channels && ask.channels.length > 0) {
    const fps: Record<string, readonly ValueLocation[]> = {};
    for (const channel of ask.channels) {
      if (!NAME.test(channel)) fail("channel");
      fps[channel] = p.wake[channel as WakePlatform]?.credential ?? [];
    }
    out.fps = fps;
  }
  return JSON.stringify(out);
}

/**
 * The live channel tag a wake for this platform covers on this type, or null
 * when the type declares no source for it, or declares one that cannot catch
 * up (catch-up "none"). The coverage rules still check the rest.
 */
export function wakeSourceFor(type: unknown, platform: WakePlatform): ChannelWakeSource | null {
  const source = agentWakeProfile(type)?.wake[platform];
  return source && source.catchUp.kind !== "none" ? source : null;
}


/**
 * The Telegram source a wake may cover on this type while profiles are on:
 * declared, and caught up by Telegram's own queue. Null otherwise (profiles
 * off: callers keep Hermes's fixed path).
 */
export function telegramWakeSource(type: unknown, env: Env = process.env): ChannelWakeSource | null {
  if (!agentProfilesEnabled(env)) return null;
  const source = wakeSourceFor(type, "telegram");
  return source && source.catchUp.kind === "server-queued" && source.credential.length === 1 ? source : null;
}

/** The agent types the owner's Telegram wake switch can apply to: Hermes, or with profiles on, every type that declares a source. */
export function telegramWakeKinds(env: Env = process.env): string[] {
  if (!agentProfilesEnabled(env)) return ["hermes"];
  return AGENT_WAKE_PROFILES.filter((p) => telegramWakeSource(p.type, env)).map((p) => p.type);
}
