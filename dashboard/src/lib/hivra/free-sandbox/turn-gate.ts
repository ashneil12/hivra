/**
 * The config the bridge writes for a pool server's turn gate (`provisioner/gvisor/free-sandbox/free-turn-gate.py`):
 * the gate is where the turn limit per server and the per-person daily reply cap are enforced, since every free
 * sandbox's traffic leaves through it. Both come from the free settings, 0 meaning off; the hosts are the pool's own
 * configuration (the free AI's hosts, and the package hosts agents may install from).
 */
import type { FreeSandboxSettings } from "./settings";

export interface TurnGateHosts {
  /** The free AI's hosts: a connection to one is a reply, limited and timed. */
  turnHosts: string[];
  /** Hosts agents may reach otherwise (packages). Everything else is refused. */
  allowHosts: string[];
}

export interface TurnGateConfig extends TurnGateHosts {
  listenHost: string;
  listenPort: number;
  maxConcurrentTurns: number;
  dailyReplySecondsCap: number;
  queueWaitSeconds: number;
  idleCloseSeconds: number;
  /** Each sandbox's address on the pool server, to its sandbox id (never a person's details). */
  sandboxes: Record<string, string>;
  stateFile: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** How the gate itself behaves; not plan values. */
export interface TurnGateRuntime {
  listenHost: string;
  listenPort: number;
  queueWaitSeconds: number;
  idleCloseSeconds: number;
  stateFile: string;
}

export function turnGateConfig(
  settings: Pick<FreeSandboxSettings, "maxConcurrentTurns" | "dailyReplySecondsCap">,
  hosts: TurnGateHosts,
  sandboxes: Record<string, string>,
  runtime: TurnGateRuntime,
): TurnGateConfig {
  for (const h of [...hosts.turnHosts, ...hosts.allowHosts]) {
    if (!HOST.test(h)) throw new Error(`Not a host name: ${h}`);
  }
  for (const ip of Object.keys(sandboxes)) {
    const m = IPV4.exec(ip);
    if (!m || m.slice(1).some((o) => Number(o) > 255)) throw new Error(`Not a sandbox address: ${ip}`);
  }
  return {
    ...runtime,
    turnHosts: [...hosts.turnHosts],
    allowHosts: [...hosts.allowHosts],
    // 0 is off for both: the gate reads it so.
    maxConcurrentTurns: Math.max(0, settings.maxConcurrentTurns),
    dailyReplySecondsCap: settings.dailyReplySecondsCap ?? 0,
    sandboxes: { ...sandboxes },
  };
}
