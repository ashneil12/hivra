/** @jest-environment node */
// Adding, changing or removing an agent on a computer is the owner's own
// action, so a sleeping computer is woken first, and one that is still waking
// answers plainly instead of reading as "busy".
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: jest.fn(), resolvePlanAgentSlots: jest.fn() }));
jest.mock("../attachment-lifecycle-store", () => ({ createAttachmentLifecycleStore: jest.fn() }));
const mockWakeById = jest.fn();
jest.mock("@/lib/hivra/sleep-aware", () => ({ wakeAgentForUserAction: (...args: unknown[]) => mockWakeById(...args) }));

import { attachReviewSha256, removeReviewSha256 } from "../attach-review";
import { beginAttachmentOperation, claimAttach, type AttachDependencies, type ComputerFacts } from "../attach-routes";

const OWNER = "owner-1";
const COMPUTER = "00000000-0000-4100-8000-000000000002";
const facts = (overrides: Partial<ComputerFacts> = {}): ComputerFacts => ({
  id: COMPUTER, name: "Desk", type: "linux-desktop", cpu: 2, ramGb: 4, deploymentMode: "my-server", status: "running",
  computerProfile: "ubuntu-desktop", computerSubstrate: "proxmox-kvm", bindingEnforced: true, chatUrl: "https://desk.example.test", ...overrides,
});
const subject = { sourceId: COMPUTER, deploymentMode: "my-server", cpu: 2, ramGb: 4 };
const grants = { workspace: true };
const WOKEN = { ok: false as const, status: 409, reason: "computer_asleep", message: "This computer is still waking up. Try again in a few seconds." };

function deps(computer: ComputerFacts, wake?: jest.Mock) {
  const store = {
    readTarget: jest.fn().mockResolvedValue({ eligible: true, reason: null, authority: { v: 1 }, liveAttachmentId: null }),
    readAttachments: jest.fn().mockResolvedValue([]),
    claim: jest.fn().mockResolvedValue({ status: "claimed", operationId: "req-1" }),
    beginOperation: jest.fn(),
  };
  return {
    store, wake,
    all: {
      store: store as unknown as AttachDependencies["store"], loadComputer: jest.fn().mockResolvedValue(computer),
      validate: jest.fn(), planSlots: jest.fn(), gatewayProtocol: jest.fn().mockResolvedValue("current"), ...(wake ? { wake } : {}),
    } as AttachDependencies,
  };
}

describe("claimAttach and a sleeping computer", () => {
  const input = { grants, reviewSha256: attachReviewSha256(subject, grants), requestId: "req-1" };

  it("wakes the computer first, then claims", async () => {
    const wake = jest.fn().mockResolvedValue({ ok: true });
    const { store, all } = deps(facts({ sleepState: "napping" }), wake);
    expect(await claimAttach(OWNER, COMPUTER, input, all)).toMatchObject({ ok: true, status: 202 });
    expect(wake).toHaveBeenCalledWith(COMPUTER);
    expect(wake.mock.invocationCallOrder[0]).toBeLessThan(store.claim.mock.invocationCallOrder[0]);
  });

  it("says the computer is still waking, and claims nothing", async () => {
    const wake = jest.fn().mockResolvedValue({ ok: false });
    const { store, all } = deps(facts({ sleepState: "hibernated" }), wake);
    expect(await claimAttach(OWNER, COMPUTER, input, all)).toEqual(WOKEN);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("treats a wake that throws as not awake", async () => {
    const wake = jest.fn().mockRejectedValue(new Error("down"));
    const { store, all } = deps(facts({ sleepState: "napping" }), wake);
    expect(await claimAttach(OWNER, COMPUTER, input, all)).toEqual(WOKEN);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it.each([
    ["awake", facts({ sleepState: "awake" })],
    ["a row without a sleep state", facts()],
    ["not running", facts({ sleepState: "napping", status: "stopped" })],
  ])("does no wake work for %s", async (_name, computer) => {
    const wake = jest.fn();
    const { all } = deps(computer, wake);
    await claimAttach(OWNER, COMPUTER, input, all);
    expect(wake).not.toHaveBeenCalled();
  });

  it("uses the by id wake when none is supplied", async () => {
    mockWakeById.mockResolvedValue({ ok: true, woke: true, cold: false });
    const { all } = deps(facts({ sleepState: "napping" }));
    expect(await claimAttach(OWNER, COMPUTER, input, all)).toMatchObject({ ok: true });
    expect(mockWakeById).toHaveBeenCalledWith(COMPUTER);
  });
});

describe("beginAttachmentOperation and a sleeping computer", () => {
  it("answers that the computer is still waking before it reads anything else", async () => {
    const wake = jest.fn().mockResolvedValue({ ok: false });
    const { store, all } = deps(facts({ sleepState: "napping" }), wake);
    const result = await beginAttachmentOperation(OWNER, COMPUTER, "attachment-1",
      { kind: "detach", reviewSha256: removeReviewSha256("attachment-1", grants), requestId: "req-2" }, all);
    expect(result).toEqual(WOKEN);
    expect(store.readAttachments).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
  });
});
