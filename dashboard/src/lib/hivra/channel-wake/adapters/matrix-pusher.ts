import "server-only";

import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { MATRIX_CHANNEL_SPEC } from "../registry";
import type { ChannelWakeAdapter } from "../types";
import {
  buildMatrixPusherHostScript,
  buildMatrixPusherPayload,
  parseMatrixPusherOutput,
  type MatrixPusherRequest,
  type MatrixPusherResult,
} from "./matrix-pusher-program";

/**
 * Matrix as a channel wake adapter. The pusher is registered once, at opt-in
 * (channel-wake/owner.ts), and stays: there is nothing to arm before a sleep,
 * nothing to take down before a wake, and no gap in which a message is
 * missed. While the agent is awake the push gateway route ignores the pushes.
 *
 * Opt-out and a changed opt-in remove the pusher from inside the computer
 * while it is awake. A pusher that is left behind anyway (the agent was
 * asleep, deleted, or the call failed) is removed by its homeserver the next
 * time it pushes: the route lists its pushkey as rejected, which the push
 * gateway API says makes the homeserver delete it.
 */
export const MATRIX_ADAPTER: ChannelWakeAdapter = {
  ...MATRIX_CHANNEL_SPEC,
  /** Registered at opt-in; an enabled row means it is in place. */
  async verifyClear() {
    return true;
  },
  /** Nothing to take down: the pusher stays, and the route ignores pushes for an awake agent. */
  async disarmForWake() {
    return { ok: true };
  },
  /** On delete the computer is going away; the homeserver drops the pusher on its next push (rejected). */
  async release() {
    return undefined;
  },
};

const PUSHER_TIMEOUT_MS = 75_000;

/** Runs the pusher program in one exact, awake computer. Never throws; the token never reaches this side. */
export async function runMatrixPusherProgram(
  target: { vmid: number; bindingTag: string | null; env: unknown },
  request: MatrixPusherRequest,
  deps: { run?: typeof runProxmoxHostScriptWithStdin } = {},
): Promise<MatrixPusherResult> {
  try {
    const script = buildMatrixPusherHostScript({ vmid: target.vmid, bindingTag: target.bindingTag });
    const run = await (deps.run ?? runProxmoxHostScriptWithStdin)(
      script,
      buildMatrixPusherPayload(request),
      target.env as Parameters<typeof runProxmoxHostScriptWithStdin>[2],
      { timeoutMs: PUSHER_TIMEOUT_MS },
    );
    return parseMatrixPusherOutput(run?.stdout ?? "");
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}
