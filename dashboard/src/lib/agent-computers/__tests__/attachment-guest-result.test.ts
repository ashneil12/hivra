import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTACHMENT_GUEST_WORKER_SHA256, parseAttachmentGuestResult } from "../attachment-guest-result";
import { ATTACHED_CODEX_ARCHIVES, ATTACHED_CODEX_BINARIES, ATTACHED_CODEX_STAGER_SHA256 } from "../attachment-staging-receipt";

const identity = {
  operationId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  installationId: "33333333-3333-4333-8333-333333333333",
  bindingId: "44444444-4444-4444-8444-444444444444",
  computerId: "55555555-5555-4555-8555-555555555555",
  sourceId: "66666666-6666-4666-8666-666666666666",
  architecture: "x86_64" as const,
};
const bootId = "77777777-7777-4777-8777-777777777777";
const expected = { identity, bootId };
// Synthetic protocol fixture, not a claim of guest execution or boot observation.
const receipt = {
  version: 1, state: "staged", operationId: identity.operationId,
  installationId: identity.installationId, runtimeId: "codex", runtimeVersion: "0.149.1",
  architecture: identity.architecture, archiveSha256: ATTACHED_CODEX_ARCHIVES.x86_64,
  binarySha256: ATTACHED_CODEX_BINARIES.x86_64, uid: 1001, gid: 1001,
  account: `hva_${identity.installationId.replaceAll("-", "").slice(0, 24)}`,
  home: `/var/lib/hivra/agent-homes/${identity.installationId}`,
  executable: `/opt/hivra/agent-installations/${identity.installationId}/codex`,
};
const result = { version: 1, identity, bootId, phase: "staged", receipt };

it("pins the reviewed worker and its exact installer/archive/binary contract", () => {
  const source = readFileSync(path.resolve(process.cwd(), "provisioner/run-attached-codex-stage.py"));
  expect(createHash("sha256").update(source).digest("hex")).toBe(ATTACHMENT_GUEST_WORKER_SHA256);
  const observation = readFileSync(path.resolve(process.cwd(), "supabase/migrations/20260906220000_hivra_attachment_guest_observation.sql"), "utf8");
  expect(observation).toContain(ATTACHMENT_GUEST_WORKER_SHA256);
  const recording = readFileSync(path.resolve(process.cwd(), "supabase/migrations/20260906230000_hivra_attachment_staging_result.sql"), "utf8");
  for (const digest of [...Object.values(ATTACHED_CODEX_ARCHIVES), ...Object.values(ATTACHED_CODEX_BINARIES)]) {
    expect(recording).toContain(digest);
  }
  for (const digest of [ATTACHED_CODEX_STAGER_SHA256, ...Object.values(ATTACHED_CODEX_ARCHIVES), ...Object.values(ATTACHED_CODEX_BINARIES)]) {
    expect(source.toString()).toContain(digest);
  }
});

it("accepts only exact durable dispatch identity, fresh expected boot and nested staged receipt", () => {
  expect(parseAttachmentGuestResult(JSON.stringify(result), expected)).toEqual(result);
  expect(parseAttachmentGuestResult(JSON.stringify(result), { ...expected, bootId: identity.operationId })).toBeNull();
});

it("decodes the captured real network-download-to-staging Linux result", () => {
  // Historical owned-container output from 2026-09-06, not a fresh boot check.
  // Expected IDs are the explicitly launched fixture; boot was read separately
  // before fetching and invoking the worker, not inferred from this JSON.
  const raw = readFileSync(path.resolve(__dirname, "fixtures/attachment-network-staging-result.json"), "utf8");
  const actual = parseAttachmentGuestResult(raw, { identity, bootId: "00000000-0000-4000-8000-000000001008" });
  expect(actual).not.toBeNull();
  expect(actual?.phase).toBe("staged");
  expect(actual?.receipt.uid).toBe(999);
  expect(actual?.receipt.gid).toBe(999);
});

it.each(Object.keys(identity) as Array<keyof typeof identity>)("rejects an unrelated outer %s", key => {
  const changed = { ...identity, [key]: key === "architecture" ? "aarch64" : bootId };
  expect(parseAttachmentGuestResult(JSON.stringify({ ...result, identity: changed }), expected)).toBeNull();
});

it.each([
  { phase: "started" }, { phase: "ready" }, { version: 2 }, { bootId: "invalid" },
  { extra: "do-not-propagate" }, { receipt: null }, { receipt: { ...receipt, state: "ready" } },
  { receipt: { ...receipt, operationId: bootId } }, { receipt: { ...receipt, installationId: bootId } },
  { receipt: { ...receipt, uid: true } }, { receipt: { ...receipt, binarySha256: "0".repeat(64) } },
])("rejects nonterminal, mismatched and extended envelopes %j", change => {
  expect(parseAttachmentGuestResult(JSON.stringify({ ...result, ...change }), expected)).toBeNull();
});

it("rejects malformed, duplicate output, oversized UTF-8 and invalid expected input", () => {
  for (const output of ["", "null", "[]", "{}", JSON.stringify(result) + "\n" + JSON.stringify(result), "é".repeat(8193)]) {
    expect(parseAttachmentGuestResult(output, expected)).toBeNull();
  }
  expect(parseAttachmentGuestResult(JSON.stringify(result), { ...expected, bootId: "" })).toBeNull();
  expect(parseAttachmentGuestResult(JSON.stringify(result), { ...expected, identity: { ...identity, sourceId: "invalid" } })).toBeNull();
  expect(parseAttachmentGuestResult(JSON.stringify({ ...result, identity: { ...identity, unexpected: true } }), expected)).toBeNull();
});
