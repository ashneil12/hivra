/** @jest-environment node */
// What the owner approves is bound to what Hivra installs (T20): each review's
// digest changes with every fact its copy names and with the pinned policy,
// installer and program, so a stale or edited review is refused with 409.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ATTACH_GRANT_POLICY, ATTACH_INSTALLER_SHA256 } from "../attach-plan";
import { ATTACH_GRANT_POLICY_SHA256, ATTACHED_SERVICE_POLICY_V2_SHA256, accessReviewSha256, attachReviewSha256,
  removeReviewSha256 } from "../attach-review";

const SUBJECT = { sourceId: "00000000-0000-4100-8000-000000000002", deploymentMode: "hivra-managed", cpu: 2, ramGb: 4 };
const ATTACHMENT = "00000000-0000-4100-8000-000000000001";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

it("pins the grant policy and the unit renderer it names", () => {
  expect(ATTACH_GRANT_POLICY_SHA256).toBe(sha256(JSON.stringify(ATTACH_GRANT_POLICY)));
  expect(ATTACHED_SERVICE_POLICY_V2_SHA256).toBe(sha256(readFileSync(path.join(__dirname, "..", "attachment-service-units.ts"))));
  expect(ATTACH_INSTALLER_SHA256).toBe(sha256(readFileSync(path.join(process.cwd(), "provisioner", "stage-attached-codex.py"))));
});

it("changes the Add review with every fact its copy names", () => {
  const base = attachReviewSha256(SUBJECT, { workspace: true });
  expect(attachReviewSha256({ ...SUBJECT }, { workspace: true })).toBe(base);
  const variants = [
    attachReviewSha256(SUBJECT, { workspace: false }),
    attachReviewSha256({ ...SUBJECT, sourceId: "00000000-0000-4100-8000-000000000009" }, { workspace: true }),
    attachReviewSha256({ ...SUBJECT, deploymentMode: "self-managed" }, { workspace: true }),
    attachReviewSha256({ ...SUBJECT, cpu: 4 }, { workspace: true }),
    attachReviewSha256({ ...SUBJECT, ramGb: 8 }, { workspace: true }),
    attachReviewSha256(SUBJECT, { workspace: true }, "0".repeat(64)),
  ];
  expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
});

it("binds Change access to its direction and Remove to the grants it removes", () => {
  const off = accessReviewSha256(ATTACHMENT, { workspace: true }, { workspace: false });
  expect(off).not.toBe(accessReviewSha256(ATTACHMENT, { workspace: false }, { workspace: true }));
  expect(off).not.toBe(accessReviewSha256("00000000-0000-4100-8000-000000000009", { workspace: true }, { workspace: false }));
  expect(removeReviewSha256(ATTACHMENT, { workspace: true })).not.toBe(removeReviewSha256(ATTACHMENT, { workspace: false }));
  expect(removeReviewSha256(ATTACHMENT, { workspace: true })).not.toBe(off);
});
