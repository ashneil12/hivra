import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTACHED_CODEX_ARCHIVES, ATTACHED_CODEX_FETCHER_SHA256, ATTACHED_CODEX_STAGER_SHA256, parseAttachmentStagingReceipt } from "../attachment-staging-receipt";

const operationId = "11111111-1111-4111-8111-111111111111";
const installationId = "22222222-2222-4222-8222-222222222222";
const expected = { operationId, installationId, architecture: "x86_64" as const };
// Synthetic protocol fixture, not evidence of a guest execution.
const receipt = {
  version: 1, state: "staged", operationId, installationId, runtimeId: "codex", runtimeVersion: "0.149.1",
  architecture: "x86_64", archiveSha256: "e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278",
  binarySha256: "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba", account: "hva_" + installationId.replaceAll("-", "").slice(0, 24),
  uid: 999, gid: 999, home: `/var/lib/hivra/agent-homes/${installationId}`,
  executable: `/opt/hivra/agent-installations/${installationId}/codex`,
};

it("pins the exact reviewed stager bytes and archive digests", () => {
  const source = readFileSync(path.resolve(process.cwd(), "provisioner/stage-attached-codex.py"));
  expect(createHash("sha256").update(source).digest("hex")).toBe(ATTACHED_CODEX_STAGER_SHA256);
  for (const digest of Object.values(ATTACHED_CODEX_ARCHIVES)) expect(source.toString()).toContain(digest);
  const reservation = readFileSync(path.resolve(process.cwd(), "supabase/migrations/20260906210000_hivra_attachment_installation_reservation.sql"), "utf8");
  expect(reservation).toContain(ATTACHED_CODEX_STAGER_SHA256);
  const fetcher = readFileSync(path.resolve(process.cwd(), "provisioner/fetch-attached-codex.py"));
  expect(createHash("sha256").update(fetcher).digest("hex")).toBe(ATTACHED_CODEX_FETCHER_SHA256);
  for (const digest of Object.values(ATTACHED_CODEX_ARCHIVES)) expect(fetcher.toString()).toContain(digest);
});

it("accepts only the requested operation and private installation without claiming readiness", () => {
  expect(parseAttachmentStagingReceipt(JSON.stringify(receipt), expected)).toEqual(receipt);
  expect(parseAttachmentStagingReceipt(JSON.stringify(receipt), { ...expected, operationId: installationId })).toBeNull();
  expect(parseAttachmentStagingReceipt(JSON.stringify(receipt), { ...expected, installationId: operationId })).toBeNull();
  expect(parseAttachmentStagingReceipt(JSON.stringify(receipt), { ...expected, architecture: "aarch64" })).toBeNull();
});

it.each([
  { state: "ready" }, { version: 2 }, { runtimeVersion: "latest" }, { runtimeId: "other" },
  { archiveSha256: "a".repeat(64) }, { binarySha256: "not-a-digest" },
  { binarySha256: "b".repeat(64) },
  { uid: 0 }, { gid: 0 }, { uid: 0.5 }, { gid: Number.MAX_SAFE_INTEGER },
  { account: "bux" }, { home: "/home/bux" }, { executable: "/usr/local/bin/codex" },
  { secret: "must-not-propagate" }, { installationId: "../other" },
])("rejects an unbound or unsafe staging response %j", change => {
  expect(parseAttachmentStagingReceipt(JSON.stringify({ ...receipt, ...change }), expected)).toBeNull();
});

it("requires the architecture-specific pinned archive", () => {
  const arm = { ...receipt, architecture: "aarch64", archiveSha256: "14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0",
    binarySha256: "2447e3fef519401ff6d6e90759ab1bf66082da48966fc6e4fe9a77108f9c20d8" };
  expect(parseAttachmentStagingReceipt(JSON.stringify(arm), { ...expected, architecture: "aarch64" })).toEqual(arm);
  expect(parseAttachmentStagingReceipt(JSON.stringify({ ...arm, archiveSha256: receipt.archiveSha256 }), { ...expected, architecture: "aarch64" })).toBeNull();
});

it("bounds untrusted output and rejects invalid expected identities", () => {
  for (const output of ["", "not json", "null", "[]", "x".repeat(8193), JSON.stringify(receipt) + "\n" + JSON.stringify(receipt)]) {
    expect(parseAttachmentStagingReceipt(output, expected)).toBeNull();
  }
  expect(parseAttachmentStagingReceipt(JSON.stringify(receipt), { ...expected, operationId: "invalid" })).toBeNull();
});
