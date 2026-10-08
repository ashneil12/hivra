import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderComputerContract } from "./computer-contract";
import { attachedContractInput, attachedMemoryMaxMb, type AttachComputerFacts, type AttachGrants } from "./attach-plan";
import { buildAttachedServiceUnits } from "./attachment-service-units";
import type { ComputerPlacementSubject } from "./agent-surfaces";

// The packets the worker sends to the attached agent's guest program
// (provisioner/attached-agent.py). Built only from durable records: the
// staged receipt, the approved grants, and the computer row.

const BASE_PROMPT_FILE = "system-prompt-attached-codex.md";
export const ATTACHED_BASE_PROMPT_SHA256 = "66a0f8f8686f00a8f9919b65d3631c64aeea669f6b9ed94e3088eeaaa21d4ab9";

function basePrompt(reader: (file: string) => Buffer): string {
  const source = reader(BASE_PROMPT_FILE);
  if (createHash("sha256").update(source).digest("hex") !== ATTACHED_BASE_PROMPT_SHA256) {
    throw new Error("The attached base prompt does not match the reviewed revision.");
  }
  return source.toString("utf8");
}

const readSource = (file: string): Buffer => readFileSync(path.resolve(process.cwd(), "provisioner", file));

export interface AttachedPacketInput {
  operationId: string;
  installationId: string;
  bootId?: string | null;
  uid: number;
  gid: number;
  agentName: string;
  computer: AttachComputerFacts & ComputerPlacementSubject;
  grants: AttachGrants;
  contractRevision: number;
}

/** AGENTS.md in the starting folder: the attached base prompt, then the contract block. */
export function attachedAgentsMd(input: AttachedPacketInput, reader: (file: string) => Buffer = readSource) {
  const contract = renderComputerContract(attachedContractInput({ agentName: input.agentName, computer: input.computer,
    installationId: input.installationId, grants: input.grants }), input.contractRevision);
  const text = `${basePrompt(reader).trimEnd()}\n\n${contract}\n`;
  return { text, contract, contractSha256: createHash("sha256").update(contract).digest("hex"),
    fileSha256: createHash("sha256").update(text).digest("hex") };
}

/** The stable facts the agent can read at /etc/hivra/attachments/<id>/computer.json. */
export function attachedComputerFacts(input: AttachedPacketInput) {
  return {
    version: 1,
    installationId: input.installationId,
    runtime: "codex",
    account: `hva_${input.installationId.replaceAll("-", "").slice(0, 24)}`,
    startingFolder: `/var/lib/hivra/agent-views/${input.installationId}`,
    grants: { workspace: input.grants.workspace },
    cannotUse: ["personal home folder", "desktop", "browser", "administrator access", "this computer's other services", "local network"],
    computer: { cpu: input.computer.cpu, memoryGb: input.computer.ramGb },
    memoryMaxMb: attachedMemoryMaxMb(input.computer.ramGb),
    contractRevision: input.contractRevision,
  };
}

export function attachedServiceDefinition(input: Pick<AttachedPacketInput, "installationId" | "uid" | "gid" | "grants" | "computer">) {
  const hex = input.installationId.replaceAll("-", "");
  return buildAttachedServiceUnits({
    installationId: input.installationId, account: `hva_${hex.slice(0, 24)}`, uid: input.uid, gid: input.gid,
    home: `/var/lib/hivra/agent-homes/${input.installationId}`,
    executable: `/opt/hivra/agent-installations/${input.installationId}/codex`,
    grants: { workspace: input.grants.workspace }, memoryMaxMb: attachedMemoryMaxMb(input.computer.ramGb),
  });
}

export function attachedActivatePacket(input: AttachedPacketInput & { activationId: string; instanceToken: string; hostAddresses: string[] },
  reader: (file: string) => Buffer = readSource) {
  const agents = attachedAgentsMd(input, reader);
  const definition = attachedServiceDefinition(input);
  return {
    packet: {
      version: 1, action: "activate", operationId: input.operationId, activationId: input.activationId,
      installationId: input.installationId, bootId: input.bootId ?? null, uid: input.uid, gid: input.gid,
      grants: { workspace: input.grants.workspace }, memoryMaxMb: attachedMemoryMaxMb(input.computer.ramGb),
      serviceDefinitionSha256: definition.sha256, instanceToken: input.instanceToken,
      agentsMd: agents.text, computerJson: attachedComputerFacts(input), hostAddresses: input.hostAddresses,
    },
    serviceDefinitionSha256: definition.sha256,
    contract: agents,
  };
}

export function attachedAccessPacket(input: AttachedPacketInput & { instanceToken: string; previousGrants: AttachGrants },
  reader: (file: string) => Buffer = readSource) {
  const next = attachedAgentsMd(input, reader);
  const previous = attachedAgentsMd({ ...input, grants: input.previousGrants, contractRevision: Math.max(1, input.contractRevision - 1) }, reader);
  return {
    packet: {
      version: 1, action: "access", operationId: input.operationId, installationId: input.installationId,
      bootId: input.bootId ?? null, uid: input.uid, gid: input.gid, memoryMaxMb: attachedMemoryMaxMb(input.computer.ramGb),
      grants: { workspace: input.grants.workspace }, previousGrants: { workspace: input.previousGrants.workspace },
      instanceToken: input.instanceToken, agentsMd: next.text, previousAgentsMd: previous.text,
    },
    contract: next,
  };
}

export function attachedRemovePacket(input: { operationId: string; installationId: string }) {
  return { packet: { version: 1, action: "remove", operationId: input.operationId, installationId: input.installationId } };
}

/** Read-only: what an access change left behind, after a lost answer. */
export function attachedStatePacket(input: { operationId: string; installationId: string; instanceToken: string | null }) {
  return { packet: { version: 1, action: "state", operationId: input.operationId, installationId: input.installationId,
    instanceToken: input.instanceToken } };
}

export function attachedObservePacket(input: { operationId: string; activationId: string; installationId: string;
  bootId: string; serviceDefinitionSha256: string; instanceToken: string }) {
  return { packet: { version: 1, action: "observe", ...input } };
}
