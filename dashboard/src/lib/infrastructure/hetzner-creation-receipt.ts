import "server-only";

import { isIP } from "node:net";
import { z } from "zod";

import type { HetznerAction, HetznerServer } from "@/lib/hetzner/client";

const ProviderId = z.string().regex(/^[1-9][0-9]*$/).refine(
  (id) => Number.isSafeInteger(Number(id)) && String(Number(id)) === id,
);
const ActionReceipt = z.object({
  id: ProviderId,
  command: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine((command) => command.trim() === command),
  status: z.enum(["running", "success", "error"]),
  resources: z.array(z.object({
    id: ProviderId,
    type: z.enum(["server", "primary_ip"]),
  }).strict()).min(1).max(2),
}).strict();

// This is private, immutable evidence from the initial POST response, not
// inventory and not permission to delete. Cleanup must also check fresh
// ownership, assignments, protections, and the owner's explicit intent.
export const HetznerCreationReceiptSchema = z.object({
  version: z.literal(1),
  serverId: ProviderId,
  primaryIpv4: z.object({
    id: ProviderId,
    ip: z.string().max(15).refine((ip) => isIP(ip) === 4),
  }).strict(),
  primaryIpv6: z.object({
    id: ProviderId,
    ip: z.string().max(43).refine((ip) => {
      const [address, prefix, extra] = ip.split("/");
      return isIP(address) === 6 && !address.includes("%") && prefix === "64" && extra === undefined;
    }),
  }).strict(),
  action: ActionReceipt,
  nextActions: z.array(ActionReceipt).max(10),
}).strict().superRefine((receipt, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Incoherent creation resources" });
  if (receipt.primaryIpv4.id === receipt.primaryIpv6.id) fail();
  if (receipt.action.command !== "create_server"
    || receipt.action.resources.length !== 1
    || receipt.action.resources[0].type !== "server"
    || receipt.action.resources[0].id !== receipt.serverId) fail();
  const actionIds = [receipt.action.id, ...receipt.nextActions.map((action) => action.id)];
  if (new Set(actionIds).size !== actionIds.length) fail();
  for (const action of receipt.nextActions) {
    if (["poweron", "start_resource"].includes(action.command)) fail();
    const ids = action.resources.map((resource) => resource.id);
    if (new Set(ids).size !== ids.length || action.resources.some((resource) =>
      resource.type !== "primary_ip"
      || ![receipt.primaryIpv4.id, receipt.primaryIpv6.id].includes(resource.id))) fail();
  }
});

export type HetznerCreationReceipt = z.infer<typeof HetznerCreationReceiptSchema>;

export function isExactHetznerCreateActionResources(
  action: Pick<HetznerAction, "resources">,
  serverId: number,
  imageId: number | undefined,
): boolean {
  if (!Number.isSafeInteger(serverId) || serverId <= 0
    || !Array.isArray(action.resources)
    || action.resources.length < 1 || action.resources.length > 2) return false;
  let servers = 0;
  let images = 0;
  for (const resource of action.resources) {
    if (!resource || !Number.isSafeInteger(resource.id) || resource.id <= 0) return false;
    if (resource.type === "server" && resource.id === serverId) servers += 1;
    else if (resource.type === "image" && Number.isSafeInteger(imageId)
      && resource.id === imageId) images += 1;
    else return false;
  }
  return servers === 1 && images <= 1;
}

function actionReceipt(action: HetznerAction) {
  return {
    id: String(action.id),
    command: action.command,
    status: action.status,
    resources: action.resources?.map((resource) => ({
      id: String(resource.id), type: resource.type,
    })),
  };
}

// Call only for the direct create response after its quoted server identity
// has been validated. Never manufacture this receipt from a later GET.
export function createHetznerCreationReceipt(
  server: HetznerServer,
  action: HetznerAction,
  nextActions: HetznerAction[],
): HetznerCreationReceipt {
  if (!isExactHetznerCreateActionResources(action, server.id, server.image?.id)) {
    throw new Error("Hetzner creation action resource identity changed");
  }
  return HetznerCreationReceiptSchema.parse({
    version: 1,
    serverId: String(server.id),
    primaryIpv4: { id: String(server.public_net.ipv4?.id), ip: server.public_net.ipv4?.ip },
    primaryIpv6: { id: String(server.public_net.ipv6?.id), ip: server.public_net.ipv6?.ip },
    // The quoted source image is a validated dependency, not owned capacity.
    // Keep the v1 ownership projection and never grant image cleanup authority.
    action: { ...actionReceipt(action), resources: [{ id: String(server.id), type: "server" }] },
    nextActions: nextActions.map(actionReceipt),
  });
}

export function assertHetznerCreationReceiptMatchesObservation(
  receipt: HetznerCreationReceipt,
  server: HetznerServer,
  action: HetznerAction,
  nextActions: HetznerAction[],
): void {
  const observed = createHetznerCreationReceipt(server, action, nextActions);
  const identity = (value: HetznerCreationReceipt) => ({
    ...value,
    action: { ...value.action, status: undefined },
    nextActions: value.nextActions.map((item) => ({
      ...item, status: undefined,
      resources: [...item.resources].sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
  if (JSON.stringify(identity(receipt)) !== JSON.stringify(identity(observed))) {
    throw new Error("Hetzner creation resource identity changed");
  }
}
