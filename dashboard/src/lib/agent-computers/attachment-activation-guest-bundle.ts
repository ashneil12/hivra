import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { parseAttachmentActivationRecord } from "./attachment-activation-store";

const FILES = {
  starter: { file: "start-attached-codex.py", digest: "d06d92137ea69ff0339043176b9cf9631b105eea1c0d19083db9321d742fa314" },
  observer: { file: "observe-attached-codex-activation.py", digest: "7ec5e67ee169d97033e2eb3cdc43e51e1153d74ff3c863ca92984811432fd0f3" },
  preflight: { file: "preflight-attached-codex-activation.py", digest: "779c3041fffcae1802559ddf48b5f2a55759805773812121991f1033e2d67781" },
  worker: { file: "run-attached-codex-stage.py", digest: "2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab" },
  stagingObserver: { file: "run-attached-codex-bundle.py", digest: "ec5760568541f03024a10c62c884638b3ba2a0bbca26c18b91260c8130111fb3" },
} as const;
type Asset = keyof typeof FILES;
const readAsset = (name: Asset): Buffer => readFileSync(path.resolve(process.cwd(), "provisioner", FILES[name].file));

/** Pure internal payload assembly, never a dispatch grant. A future host caller
 * must hold the exact operation fence and obtain a fresh one-time DB grant for
 * start. Historical activation records permit observation only, not restart.
 */
export function buildAttachmentActivationGuestBundle(
  action: "start" | "observe", record: unknown, input: AttachmentExecutionSnapshot,
  reader: (name: Asset) => Buffer = readAsset,
): { program: string; stdin: string } {
  const snapshot = parseAttachmentExecutionSnapshot(input, input?.ownerId, input?.operationId);
  const request = snapshot && parseAttachmentActivationRecord(record, snapshot);
  if (!snapshot || !request || !["start", "observe"].includes(action)
    || (action === "start" && snapshot.desiredState !== "running")) {
    throw new Error("Invalid activation bundle request.");
  }
  const sources = {} as Record<Asset, Buffer>;
  for (const name of Object.keys(FILES) as Asset[]) {
    const loaded = reader(name);
    if (!Buffer.isBuffer(loaded) || loaded.length > 65536) throw new Error("Invalid activation asset bytes.");
    const source = Buffer.from(loaded);
    if (createHash("sha256").update(source).digest("hex") !== FILES[name].digest) {
      throw new Error("Activation assets do not match the reviewed revision.");
    }
    sources[name] = source;
  }
  const start = { version: 1, preflight: sources.preflight.toString("base64"), packet: {
    version: 1, request, assets: { worker: sources.worker.toString("base64"), observer: sources.stagingObserver.toString("base64") },
  } };
  const startInput = JSON.stringify(start);
  if (Buffer.byteLength(startInput, "utf8") > 131072) throw new Error("Activation packet exceeds the guest limit.");
  if (action === "start") return { program: sources.starter.toString("utf8"), stdin: startInput };
  const stdin = JSON.stringify({ version: 1, starter: sources.starter.toString("base64"), packet: start });
  if (Buffer.byteLength(stdin, "utf8") > 196608) throw new Error("Activation observation exceeds the guest limit.");
  return { program: sources.observer.toString("utf8"), stdin };
}
