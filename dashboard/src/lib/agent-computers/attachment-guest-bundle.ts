import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTACHED_CODEX_FETCHER_SHA256, ATTACHED_CODEX_STAGER_SHA256 } from "./attachment-staging-receipt";
import { ATTACHMENT_GUEST_WORKER_SHA256, snapshotAttachmentGuestExpectation,
  type ExpectedAttachmentGuestResult } from "./attachment-guest-result";

const ATTACHMENT_BUNDLE_RUNNER_SHA256 = "63d48ded14d682353996dd9212c1a8c396a71afa72916c21a2a6950971b7b8da";
const FILES = {
  fetcher: { file: "fetch-attached-codex.py", digest: ATTACHED_CODEX_FETCHER_SHA256 },
  worker: { file: "run-attached-codex-stage.py", digest: ATTACHMENT_GUEST_WORKER_SHA256 },
  stager: { file: "stage-attached-codex.py", digest: ATTACHED_CODEX_STAGER_SHA256 },
  runner: { file: "run-attached-codex-bundle.py", digest: ATTACHMENT_BUNDLE_RUNNER_SHA256 },
} as const;
type Asset = keyof typeof FILES;
const readAsset = (name: Asset): Buffer => readFileSync(path.resolve(process.cwd(), "provisioner", FILES[name].file));

/** Internal bounded QGA payload, not an authorization token. The caller must
 * obtain the separate durable dispatch grant before sending a stage action.
 * No caller path, URL, shell command or unpinned asset can enter this bundle.
 */
export function buildAttachmentGuestBundle(
  action: "fetch" | "stage" | "observe", input: ExpectedAttachmentGuestResult,
  reader: (name: Asset) => Buffer = readAsset,
): { program: string; stdin: string } {
  const expected = snapshotAttachmentGuestExpectation(input);
  if (!expected || !["fetch", "stage", "observe"].includes(action)) throw new Error("Invalid attachment bundle request.");
  const sources = {} as Record<Asset, Buffer>;
  for (const name of Object.keys(FILES) as Asset[]) {
    const loaded = reader(name);
    if (!Buffer.isBuffer(loaded) || loaded.length > 65536) throw new Error("Invalid attachment asset bytes.");
    const source = Buffer.from(loaded);
    if (source.length > 65536
      || createHash("sha256").update(source).digest("hex") !== FILES[name].digest) {
      throw new Error("Attachment bundle assets do not match the reviewed revision.");
    }
    sources[name] = source;
  }
  const stdin = JSON.stringify({ version: 1, action, identity: expected.identity, bootId: expected.bootId,
    assets: { fetcher: sources.fetcher.toString("base64"), worker: sources.worker.toString("base64"), stager: sources.stager.toString("base64") } });
  if (Buffer.byteLength(stdin, "utf8") > 65536) throw new Error("Attachment bundle exceeds its transport limit.");
  return { program: sources.runner.toString("utf8"), stdin };
}
