/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("../kit-delivery", () => ({ readKitState: jest.fn(async () => ({ state: "delivered" })) }));
jest.mock("../store", () => {
  const actual = jest.requireActual("../store");
  return { ...actual, loadOwnedRows: jest.fn(), loadLinks: jest.fn(async () => []), insertLinks: jest.fn(async (_u: string, pairs: unknown[]) => pairs.length),
    deleteLink: jest.fn(), markKitDirty: jest.fn(async () => undefined) };
});
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { addLinks, readLinksView, removeLink } from "../routes";
import { deleteLink, insertLinks, loadOwnedRows, markKitDirty } from "../store";

const OWNER = "user_owner";
const row = (id: string, extra: Record<string, unknown>) => ({ id, user_id: OWNER, name: id, status: "running", ...extra });
const CLAUDE = row("claude", { type: "claude-code", computer_substrate: "proxmox-kvm" });
const CODEX = row("codex", { type: "codex", computer_substrate: "provider-vm" });
const DO = row("hermes-do", { type: "hermes", computer_substrate: "do-managed-session" });
const STUDIO = row("studio", { type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true });
const OMARCHY = row("omarchy", { type: "linux-desktop", computer_profile: "omarchy", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true });
const WINDOWS = row("windows", { type: "linux-desktop", computer_profile: "windows", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadOwnedRows).mockResolvedValue([CLAUDE, CODEX, DO, STUDIO, OMARCHY, WINDOWS] as never);
});

describe("agent link routes", () => {
  it("links one pair and marks that agent's kit out of date", async () => {
    const result = await addLinks(OWNER, { agentId: "claude", computerId: "studio", from: "computer" });
    expect(result).toEqual({ ok: true, value: { added: 1, agentIds: ["claude"] } });
    expect(insertLinks).toHaveBeenCalledWith(OWNER, [{ agentId: "claude", computerId: "studio" }], "computer");
    expect(markKitDirty).toHaveBeenCalledWith(OWNER, ["claude"]);
  });

  it("links an agent to all the computers agents can use", async () => {
    await addLinks(OWNER, { agentId: "claude", all: true });
    expect(jest.mocked(insertLinks).mock.calls[0][1]).toEqual([{ agentId: "claude", computerId: "studio" }, { agentId: "claude", computerId: "omarchy" }]);
  });

  it("links a computer to all the agents that can use computers", async () => {
    await addLinks(OWNER, { computerId: "omarchy", all: true });
    expect(jest.mocked(insertLinks).mock.calls[0][1]).toEqual([{ agentId: "claude", computerId: "omarchy" }, { agentId: "codex", computerId: "omarchy" }]);
    expect(jest.mocked(insertLinks).mock.calls[0][2]).toBe("computer");
  });

  it("refuses foreign rows, swapped ends and ends that can't link", async () => {
    expect(await addLinks(OWNER, { agentId: "nope", computerId: "studio" })).toMatchObject({ ok: false, status: 404 });
    expect(await addLinks(OWNER, { agentId: "studio", computerId: "omarchy" })).toMatchObject({ ok: false, status: 400 });
    expect(await addLinks(OWNER, { agentId: "claude", computerId: "windows" })).toMatchObject({ ok: false, status: 409 });
    expect(await addLinks(OWNER, { agentId: "hermes-do", computerId: "studio" })).toMatchObject({ ok: false, status: 409 });
    expect(await addLinks(OWNER, { agentId: "claude" })).toMatchObject({ ok: false, status: 400 });
    expect(insertLinks).not.toHaveBeenCalled();
  });

  it("shows the other end's choices with reasons", async () => {
    const view = await readLinksView(OWNER, "claude", "https://x/api/agent-link");
    expect(view.ok && view.value.subject).toEqual({ id: "claude", kind: "agent", available: true });
    expect(view.ok && view.value.candidates.map((c) => [c.id, c.available])).toEqual([["studio", true], ["omarchy", true], ["windows", false]]);
    expect(view.ok && view.value.kit).toEqual({ state: "delivered" });
    const computer = await readLinksView(OWNER, "studio", "https://x/api/agent-link");
    expect(computer.ok && computer.value.candidates.map((c) => [c.id, c.available])).toEqual([["claude", true], ["codex", true], ["hermes-do", false]]);
    expect(computer.ok && computer.value.kit).toBeUndefined();
  });

  it("removes a link and marks its agent's kit out of date", async () => {
    jest.mocked(deleteLink).mockResolvedValue({ agentId: "claude" });
    expect(await removeLink(OWNER, "link")).toEqual({ ok: true, value: { agentId: "claude" } });
    expect(markKitDirty).toHaveBeenCalledWith(OWNER, ["claude"]);
    jest.mocked(deleteLink).mockResolvedValue(null);
    expect(await removeLink(OWNER, "other")).toMatchObject({ ok: false, status: 404 });
  });
});
