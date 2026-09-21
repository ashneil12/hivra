import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAttachmentActivationGuestBundle } from "./attachment-activation-guest-bundle";
import { parseAttachmentActivationResult, type AttachmentActivationObservation } from "./attachment-activation-result";
import type { AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";

const FILES = {
  probe: { file: "probe-attached-codex-native.py", digest: "0b10410217bac283be6313fbc7b9cb5c90f6fa6f70f895ffaf4fc53f817c1be0" },
  protocol: { file: "attached-codex-protocol.py", digest: "60cef5e61a6445410915bac17e78cb36f0784584ac4d81d483757b3560142569" },
} as const;
type Asset = keyof typeof FILES;
const readAsset = (name: Asset): Buffer => readFileSync(path.resolve(process.cwd(), "provisioner", FILES[name].file));
export type AttachmentNativeObservation = Omit<AttachmentActivationObservation, "state" | "mainPid"> & {
  state: "native_protocol_available"; mainPid: number;
};

/** Pure protocol-observation payload, not dispatch or publication authority. */
export function buildAttachmentNativeProbeBundle(
  record: unknown, snapshot: AttachmentExecutionSnapshot, reader: (name: Asset) => Buffer = readAsset,
): { program: string; stdin: string } {
  const observation = buildAttachmentActivationGuestBundle("observe", record, snapshot);
  const sources = {} as Record<Asset, Buffer>;
  for (const name of Object.keys(FILES) as Asset[]) {
    const loaded = reader(name);
    if (!Buffer.isBuffer(loaded) || loaded.length > 65536) throw new Error("Invalid native probe asset.");
    const source = Buffer.from(loaded);
    if (createHash("sha256").update(source).digest("hex") !== FILES[name].digest) {
      throw new Error("Native probe assets do not match the reviewed revision.");
    }
    sources[name] = source;
  }
  const stdin = JSON.stringify({ version: 1, observer: Buffer.from(observation.program, "utf8").toString("base64"),
    protocol: sources.protocol.toString("base64"), packet: JSON.parse(observation.stdin) });
  if (Buffer.byteLength(stdin, "utf8") > 262144) throw new Error("Native probe packet exceeds the guest limit.");
  return { program: sources.probe.toString("utf8"), stdin };
}

/** Reuse the exact activation identity contract without accepting generic
 * process status as native protocol evidence. This is not useful-work readiness.
 */
export function parseAttachmentNativeProbeResult(
  stdout: string, record: unknown, snapshot: AttachmentExecutionSnapshot,
): AttachmentNativeObservation | null {
  try {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 32768) return null;
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !("state" in value) || value.state !== "native_protocol_available") return null;
    const observation = parseAttachmentActivationResult("observe", JSON.stringify({ ...value, state: "process_running" }), record, snapshot);
    if (!observation || !("state" in observation) || observation.state !== "process_running" || observation.mainPid === undefined) return null;
    return { ...observation, state: "native_protocol_available", mainPid: observation.mainPid };
  } catch { return null; }
}
