import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSafeHandoffText,
  parseAuthResponse,
  parseRevisionEvidence,
  parseVercelInspect,
  verifyCanaryRelease,
} from "../verify-canary-release.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const EXPECTED_ALIAS = "canary.hermesos.cloud";
const EXPECTED_URL = `https://${EXPECTED_ALIAS}/dashboard/workspace`;
const CREATED_AT_MS = Date.parse("2026-08-24T20:00:00.000Z");
const VERIFIED_AT_MS = Date.parse("2026-08-24T20:05:00.000Z");
const CLI_PATH = fileURLToPath(
  new URL("../verify-canary-release.mjs", import.meta.url),
);

function inspectFixture(overrides = {}) {
  return JSON.stringify({
    id: "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn",
    readyState: "READY",
    target: "production",
    aliases: [EXPECTED_ALIAS, "hermesos-canary.vercel.app"],
    createdAt: CREATED_AT_MS,
    ...overrides,
  });
}

const clerkRewriteHeaders = [
  "HTTP/2 404",
  "content-type: text/html; charset=utf-8",
  "x-clerk-auth-status: signed-out",
  "x-clerk-auth-reason: protect-rewrite, dev-browser-missing",
  "",
].join("\r\n");

const redirectHeaders = [
  "HTTP/2 307",
  "location: /sign-in?redirect_url=%2Fdashboard%2Fworkspace",
  "",
].join("\r\n");

test("parses exact READY production inspect evidence with timestamp provenance", () => {
  const evidence = parseVercelInspect(inspectFixture(), {
    expectedAlias: EXPECTED_ALIAS,
    nowMs: VERIFIED_AT_MS,
  });

  assert.deepEqual(evidence, {
    readyState: "READY",
    target: "production",
    alias: EXPECTED_ALIAS,
    deploymentId: "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn",
    deploymentCreatedAt: "2026-08-24T20:00:00.000Z",
    deploymentCreatedAtSource: "Vercel inspect JSON.createdAt",
  });
  assert.equal("buildGeneratedAt" in evidence, false);
});

test("rejects malformed Vercel inspect JSON", () => {
  assert.throws(
    () => parseVercelInspect("{not-json", { expectedAlias: EXPECTED_ALIAS }),
    /malformed Vercel inspect JSON/i,
  );
});

for (const [name, overrides, expectedError] of [
  ["non-READY state", { readyState: "BUILDING" }, /readyState must be READY/i],
  ["missing state", { readyState: undefined }, /readyState must be READY/i],
  ["non-production target", { target: "preview" }, /target must be production/i],
  ["missing target", { target: undefined }, /target must be production/i],
  ["wrong alias", { aliases: ["preview.example.com"] }, /expected alias/i],
  ["missing aliases", { aliases: undefined }, /aliases must be an array/i],
  ["invalid deployment ID", { id: "deployment with spaces" }, /deployment ID/i],
  ["missing deployment ID", { id: "" }, /deployment ID/i],
  ["invalid createdAt string", { createdAt: "yesterday" }, /createdAt/i],
  ["invalid createdAt seconds", { createdAt: 1_700_000_000 }, /createdAt/i],
  ["future createdAt", { createdAt: VERIFIED_AT_MS + 60 * 60_000 }, /createdAt/i],
]) {
  test(`rejects inspect evidence with ${name}`, () => {
    assert.throws(
      () =>
        parseVercelInspect(inspectFixture(overrides), {
          expectedAlias: EXPECTED_ALIAS,
          nowMs: VERIFIED_AT_MS,
        }),
      expectedError,
    );
  });
}

test("accepts the configured Clerk protect-rewrite boundary without workspace content", () => {
  assert.deepEqual(
    parseAuthResponse({
      headers: clerkRewriteHeaders,
      body: "<!doctype html><title>Not Found</title>",
      expectedUrl: EXPECTED_URL,
    }),
    {
      status: 404,
      boundary: "clerk-protect-rewrite",
      location: null,
    },
  );
});

test("accepts an exact same-origin Clerk sign-in redirect", () => {
  assert.deepEqual(
    parseAuthResponse({
      headers: redirectHeaders,
      body: "",
      expectedUrl: EXPECTED_URL,
    }),
    {
      status: 307,
      boundary: "clerk-sign-in-redirect",
      location:
        "https://canary.hermesos.cloud/sign-in?redirect_url=%2Fdashboard%2Fworkspace",
    },
  );
});

for (const [name, headers, body, expectedError] of [
  ["success status", "HTTP/2 200\r\n", "", /unexpected unauthenticated status/i],
  [
    "wrong redirect location",
    "HTTP/2 307\r\nlocation: /dashboard/workspace\r\n",
    "",
    /Clerk sign-in boundary/i,
  ],
  [
    "cross-origin redirect",
    "HTTP/2 307\r\nlocation: https://attacker.invalid/sign-in\r\n",
    "",
    /same-origin/i,
  ],
  ["404 without Clerk headers", "HTTP/2 404\r\n", "", /Clerk protect-rewrite/i],
  [
    "private workspace body",
    clerkRewriteHeaders,
    '<main data-testid="unified-workspace">Compatibility session</main>',
    /exposed private workspace content/i,
  ],
]) {
  test(`rejects auth evidence with ${name}`, () => {
    assert.throws(
      () => parseAuthResponse({ headers, body, expectedUrl: EXPECTED_URL }),
      expectedError,
    );
  });
}

test("requires exact full expected, local, origin, and visible revisions", () => {
  assert.deepEqual(
    parseRevisionEvidence({
      expectedSha: SHA,
      localSha: SHA,
      originSha: SHA,
      visibleSha: SHA,
    }),
    { expectedSha: SHA, localSha: SHA, originSha: SHA, visibleSha: SHA },
  );
});

for (const [name, evidence] of [
  ["short expected SHA", { expectedSha: SHA.slice(0, 12), localSha: SHA, originSha: SHA }],
  ["local mismatch", { expectedSha: SHA, localSha: OTHER_SHA, originSha: SHA }],
  ["origin mismatch", { expectedSha: SHA, localSha: SHA, originSha: OTHER_SHA }],
  [
    "visible mismatch",
    { expectedSha: SHA, localSha: SHA, originSha: SHA, visibleSha: OTHER_SHA },
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseRevisionEvidence(evidence), /revision|SHA/i);
  });
}

test("accepts allowlisted ordinal-only handoff evidence", () => {
  assert.doesNotThrow(() =>
    assertSafeHandoffText([
      `Full SHA: ${SHA}`,
      `Exact URL: ${EXPECTED_URL}`,
      "Hermes agent 1: workspace ready, terminal ready",
      "Hivra agent 1: detail unknown; support remains unknown",
      "Limitation: compatibility sessions are not durable across clients.",
      "Rollback flags: HIVRA_WORKSPACE_SHELL_ENABLED and NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED.",
    ].join("\n")),
  );
});

for (const [name, text] of [
  ["secret key", "CLERK_SECRET_KEY=sk_test_DO_NOT_EXPOSE_123456"],
  ["bearer credential", "Authorization: Bearer abc.def.ghi"],
  ["signed URL", "https://agent.example/path?token=private"],
  ["raw UID", "uid: h-private-agent-123"],
  ["raw user ID", "user_2abcPrivate"],
  ["transcript", "transcript: private conversation"],
  ["raw error", "raw error: provider connection failed"],
  ["placeholder", "TODO: paste deployment evidence later"],
]) {
  test(`rejects forbidden handoff sentinel: ${name}`, () => {
    assert.throws(() => assertSafeHandoffText(text), /forbidden handoff sentinel/i);
  });
}

test("returns one exact passing combined result with separate verifier time", () => {
  const evidence = verifyCanaryRelease({
    inspectJson: inspectFixture(),
    headers: clerkRewriteHeaders,
    body: "<!doctype html><title>Not Found</title>",
    expectedAlias: EXPECTED_ALIAS,
    expectedUrl: EXPECTED_URL,
    expectedSha: SHA,
    localSha: SHA,
    originSha: SHA,
    visibleSha: SHA,
    now: () => new Date(VERIFIED_AT_MS),
  });

  assert.equal(evidence.deploymentCreatedAt, "2026-08-24T20:00:00.000Z");
  assert.equal(evidence.verifiedAt, "2026-08-24T20:05:00.000Z");
  assert.notEqual(evidence.deploymentCreatedAt, evidence.verifiedAt);
  assert.equal("buildGeneratedAt" in evidence, false);
});

test("CLI exits zero only for the exact passing fixture", () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-canary-release-test-"));
  const inspectPath = join(directory, "inspect.json");
  const headersPath = join(directory, "headers.txt");
  const bodyPath = join(directory, "body.txt");
  writeFileSync(inspectPath, inspectFixture(), "utf8");
  writeFileSync(headersPath, clerkRewriteHeaders, "utf8");
  writeFileSync(bodyPath, "<!doctype html><title>Not Found</title>", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "live",
      "--inspect",
      inspectPath,
      "--headers",
      headersPath,
      "--body",
      bodyPath,
      "--expected-sha",
      SHA,
      "--expected-alias",
      EXPECTED_ALIAS,
      "--expected-url",
      EXPECTED_URL,
      "--local-sha",
      SHA,
      "--origin-sha",
      SHA,
      "--visible-sha",
      SHA,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.deploymentId, "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn");
  assert.equal(output.expectedSha, SHA);
});

test("CLI exits nonzero for malformed inspect JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-canary-release-test-"));
  const inspectPath = join(directory, "inspect.json");
  const headersPath = join(directory, "headers.txt");
  const bodyPath = join(directory, "body.txt");
  writeFileSync(inspectPath, "not-json", "utf8");
  writeFileSync(headersPath, clerkRewriteHeaders, "utf8");
  writeFileSync(bodyPath, "", "utf8");

  const result = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "live",
      "--inspect",
      inspectPath,
      "--headers",
      headersPath,
      "--body",
      bodyPath,
      "--expected-sha",
      SHA,
      "--expected-alias",
      EXPECTED_ALIAS,
      "--expected-url",
      EXPECTED_URL,
      "--local-sha",
      SHA,
      "--origin-sha",
      SHA,
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /malformed Vercel inspect JSON/i);
});
