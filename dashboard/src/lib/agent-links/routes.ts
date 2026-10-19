import "server-only";

// What the owner routes decide: the owner from auth only, both ends looked up
// with that owner, each end's eligibility in Manage's own words.

import { isComputerRow, linkSource, linkTarget } from "./eligibility";
import { readKitState, type KitDeliveryResult } from "./kit-delivery";
import { candidatesFor, deleteLink, insertLinks, linkViews, loadLinks, loadOwnedRows, markKitDirty,
  type LinkCandidate, type LinkView, type OwnedRow } from "./store";

export interface LinksView {
  subject: { id: string; kind: "agent" | "computer"; available: boolean; reason?: string };
  links: LinkView[];
  candidates: LinkCandidate[];
  /** The agent's kit, on an agent's page only. */
  kit?: KitDeliveryResult;
}

export type LinkRouteResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

const notFound = { ok: false as const, status: 404, message: "Not found." };

export async function readLinksView(userId: string, subjectId: string, endpoint: string): Promise<LinkRouteResult<LinksView>> {
  const rows = await loadOwnedRows(userId);
  const subject = rows.find((row) => row.id === subjectId);
  if (!subject) return notFound;
  const isComputer = isComputerRow(subject);
  const side = isComputer ? linkTarget(subject) : linkSource(subject);
  const links = await loadLinks(userId, isComputer ? { computerId: subject.id } : { agentId: subject.id });
  const views = linkViews(links, rows);
  const linkedIds = new Set(views.map((view) => (isComputer ? view.agentId : view.computerId)));
  return {
    ok: true,
    value: {
      subject: { id: subject.id, kind: isComputer ? "computer" : "agent", available: side.ok, ...(side.ok ? {} : { reason: side.reason }) },
      links: views,
      candidates: candidatesFor(subject, rows, linkedIds),
      ...(isComputer ? {} : { kit: await readKitState(userId, subject, endpoint) }),
    },
  };
}

export interface AddLinksInput {
  agentId?: string;
  computerId?: string;
  /** With only one end named: link it to every eligible row on the other end. */
  all?: boolean;
  /** Which page the owner linked from. */
  from?: "agent" | "computer";
}

/** Adds links; returns the agents whose kits changed. */
export async function addLinks(userId: string, input: AddLinksInput): Promise<LinkRouteResult<{ added: number; agentIds: string[] }>> {
  const rows = await loadOwnedRows(userId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const agent = input.agentId ? byId.get(input.agentId) : undefined;
  const computer = input.computerId ? byId.get(input.computerId) : undefined;
  if ((input.agentId && !agent) || (input.computerId && !computer)) return notFound;
  if (agent && isComputerRow(agent)) return { ok: false, status: 400, message: "That's a computer, not an agent." };
  if (computer && !isComputerRow(computer)) return { ok: false, status: 400, message: "That's an agent, not a computer." };

  const refusal = (row: OwnedRow, side: ReturnType<typeof linkSource> | ReturnType<typeof linkTarget>) =>
    side.ok ? null : { ok: false as const, status: 409, message: `${row.name ?? "This"}: ${side.reason}` };
  let pairs: { agentId: string; computerId: string }[];
  if (agent && computer) {
    const blocked = refusal(agent, linkSource(agent)) ?? refusal(computer, linkTarget(computer));
    if (blocked) return blocked;
    pairs = [{ agentId: agent.id, computerId: computer.id }];
  } else if (agent && input.all) {
    const blocked = refusal(agent, linkSource(agent));
    if (blocked) return blocked;
    pairs = rows.filter((row) => isComputerRow(row) && linkTarget(row).ok).map((row) => ({ agentId: agent.id, computerId: row.id }));
  } else if (computer && input.all) {
    const blocked = refusal(computer, linkTarget(computer));
    if (blocked) return blocked;
    pairs = rows.filter((row) => !isComputerRow(row) && linkSource(row).ok).map((row) => ({ agentId: row.id, computerId: computer.id }));
  } else {
    return { ok: false, status: 400, message: "Choose an agent and a computer." };
  }
  if (pairs.length === 0) {
    return { ok: false, status: 409, message: agent ? "You have no computers agents can use yet." : "You have no agents that can use computers yet." };
  }
  const added = await insertLinks(userId, pairs, input.from ?? (computer && !agent ? "computer" : "agent"));
  const agentIds = [...new Set(pairs.map((pair) => pair.agentId))];
  await markKitDirty(userId, agentIds);
  return { ok: true, value: { added, agentIds } };
}

export async function removeLink(userId: string, linkId: string): Promise<LinkRouteResult<{ agentId: string }>> {
  const removed = await deleteLink(userId, linkId);
  if (!removed) return notFound;
  await markKitDirty(userId, [removed.agentId]);
  return { ok: true, value: removed };
}
