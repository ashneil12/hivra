jest.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAttachmentGuestBundle } from "../attachment-guest-bundle";
const expected = {
  identity: { operationId: "11111111-1111-4111-8111-111111111111", dispatchId: "22222222-2222-4222-8222-222222222222",
    installationId: "33333333-3333-4333-8333-333333333333", bindingId: "44444444-4444-4444-8444-444444444444",
    computerId: "55555555-5555-4555-8555-555555555555", sourceId: "66666666-6666-4666-8666-666666666666", architecture: "x86_64" as const },
  bootId: "77777777-7777-4777-8777-777777777777",
};

it.each(["fetch", "stage", "observe"] as const)("packages only verified sources for the explicit %s action within QGA limits", action => {
  const bundle = buildAttachmentGuestBundle(action, expected);
  const value = JSON.parse(bundle.stdin);
  expect(value).toMatchObject({ version: 1, action, identity: expected.identity, bootId: expected.bootId });
  expect(Object.keys(value.assets).sort()).toEqual(["fetcher", "stager", "worker"]);
  expect(Buffer.byteLength(bundle.stdin)).toBeLessThanOrEqual(65536);
  expect(bundle.program).toBe(readFileSync(path.resolve(process.cwd(), "provisioner/run-attached-codex-bundle.py"), "utf8"));
});

it("rejects invalid identity/boot/action before reading any asset", () => {
  const reader = jest.fn();
  expect(() => buildAttachmentGuestBundle("fetch", { ...expected, bootId: expected.bootId + "\n" }, reader)).toThrow();
  expect(() => buildAttachmentGuestBundle("fetch", { ...expected, identity: { ...expected.identity, sourceId: "invalid" } }, reader)).toThrow();
  expect(() => buildAttachmentGuestBundle("arbitrary" as "stage", expected, reader)).toThrow();
  expect(reader).not.toHaveBeenCalled();
});

it("rejects altered assets rather than executing or sending them", () => {
  expect(() => buildAttachmentGuestBundle("stage", expected, () => Buffer.from("print('unreviewed')"))).toThrow(/reviewed revision/);
});
