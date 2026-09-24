import "server-only";

import { createHash } from "node:crypto";
import { ATTACH_GRANT_POLICY, ATTACH_INSTALLER_SHA256, type AttachGrants } from "./attach-plan";
import { ATTACHED_AGENT_PROGRAM_SHA256 } from "./attached-agent-host";

// What the owner approves is bound to what Hivra installs (T20). Each review
// the gate, Change access and Remove show has a digest computed here from the
// normalized grants, the computer facts the copy names, and the pinned policy,
// installer and program the unit and contract are rendered from. The route
// recomputes it and refuses a mismatch with 409; the database stores it.

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** The reviewed grant policy the database pins in every intent v2. */
export const ATTACH_GRANT_POLICY_SHA256 = sha256(JSON.stringify(ATTACH_GRANT_POLICY));

/**
 * The reviewed service policy v2: the SHA-256 of the unit renderer's bytes
 * (attachment-service-units.ts). The database accepts an activation only with
 * this digest, and a test keeps it equal to the file; any edit to the renderer
 * is a new policy and needs a new database gate.
 */
export const ATTACHED_SERVICE_POLICY_V2_SHA256 = "12b0537d0db3de953d07ddd3d050508c47af0d6c9ff1238abdaee7fae4f4917d";

export interface AttachReviewSubject {
  sourceId: string;
  deploymentMode: string | null;
  cpu: number;
  ramGb: number;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** The review "Add Codex to this computer". */
export function attachReviewSha256(subject: AttachReviewSubject, grants: AttachGrants, servicePolicySha256 = ATTACHED_SERVICE_POLICY_V2_SHA256): string {
  return sha256(canonical({ version: 1, kind: "attach", runtime: "codex", sourceId: subject.sourceId,
    deploymentMode: subject.deploymentMode, cpu: Number(subject.cpu), ramGb: Number(subject.ramGb),
    grants: { workspace: grants.workspace }, grantPolicySha256: ATTACH_GRANT_POLICY_SHA256,
    installerSha256: ATTACH_INSTALLER_SHA256, servicePolicySha256, programSha256: ATTACHED_AGENT_PROGRAM_SHA256 }));
}

/** The Change access review, from the grants the agent has to the new ones. */
export function accessReviewSha256(attachmentId: string, from: AttachGrants, to: AttachGrants,
  servicePolicySha256 = ATTACHED_SERVICE_POLICY_V2_SHA256): string {
  return sha256(canonical({ version: 1, kind: "access_change", attachmentId, from: { workspace: from.workspace },
    to: { workspace: to.workspace }, grantPolicySha256: ATTACH_GRANT_POLICY_SHA256, servicePolicySha256 }));
}

/** The Remove review, naming the grants the agent has. */
export function removeReviewSha256(attachmentId: string, grants: AttachGrants): string {
  return sha256(canonical({ version: 1, kind: "detach", attachmentId, grants: { workspace: grants.workspace } }));
}
