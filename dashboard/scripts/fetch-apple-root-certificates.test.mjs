import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureAppleRootCertificates } from "./fetch-apple-root-certificates.mjs";

const fixtures = [Buffer.from("reviewed fixture certificate A"), Buffer.from("reviewed fixture certificate B")];
const certificates = fixtures.map((bytes, index) => ({
  name: `FixtureRoot-${index}.cer`,
  sourceUrl: `https://www.apple.com/fixture-${index}.cer`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
}));

test("acquires every reviewed Apple certificate and reuses verified cache bytes", async (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-apple-certs-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    const entry = certificates.find((candidate) => candidate.sourceUrl === url);
    assert.ok(entry);
    const bytes = fixtures[certificates.indexOf(entry)];
    return new Response(bytes, { status: 200 });
  };

  const first = await ensureAppleRootCertificates({ dashboardRoot: fixture, fetchImpl, certificates });
  assert.equal(first.acquired.length, certificates.length);
  assert.equal(requests, certificates.length);
  const second = await ensureAppleRootCertificates({ dashboardRoot: fixture, fetchImpl, certificates });
  assert.deepEqual(second.acquired, []);
  assert.equal(requests, certificates.length);
});

test("fails closed before writing when Apple returns unreviewed bytes", async (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-apple-certs-bad-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  await assert.rejects(
    ensureAppleRootCertificates({
      dashboardRoot: fixture,
      fetchImpl: async () => new Response("not a certificate", { status: 200 }),
      certificates,
    }),
    /integrity check failed/,
  );
});
