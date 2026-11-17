jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn(() => Promise.resolve(null)) }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: (config: { hostId: string }, env: Record<string, string>) => ({ ...env, PROXMOX_PUBLIC_IP: config.hostId === "alpha" ? "203.0.113.11" : "" }),
}));

import { checkKeyBinding, keyBindingMode, resetKeyBindingCache } from "../key-binding";

function db(row: Record<string, unknown> | null) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => chain };
}
const managed = { id: "agent-1", proxmox_host: "alpha", deployment_mode: "hivra-managed", deployment_target_id: null, computer_substrate: "proxmox-kvm", status: "running" };
const base = { keyId: "key-1", userId: "u", metadata: { agentId: "agent-1" } };

describe("managed AI key binding", () => {
  beforeEach(() => resetKeyBindingCache());

  it("is off unless set to observe or enforce", () => {
    expect(keyBindingMode({})).toBe("off");
    expect(keyBindingMode({ HIVRA_MANAGED_KEY_BINDING: "ENFORCE" })).toBe("enforce");
  });

  it("allows the key from its computer's host", async () => {
    const decision = await checkKeyBinding({ ...base, caller: { address: "203.0.113.11", via: "direct" } }, { db: db(managed), env: { HIVRA_MANAGED_KEY_BINDING: "enforce" } });
    expect(decision).toEqual({ allowed: true, outcome: "match" });
  });

  it("refuses it from anywhere else only when enforcing", async () => {
    const away = { ...base, caller: { address: "198.51.100.7", via: "direct" as const } };
    expect(await checkKeyBinding(away, { db: db(managed), env: { HIVRA_MANAGED_KEY_BINDING: "observe" } })).toEqual({ allowed: true, outcome: "mismatch" });
    resetKeyBindingCache();
    expect(await checkKeyBinding(away, { db: db(managed), env: { HIVRA_MANAGED_KEY_BINDING: "enforce" } })).toEqual({ allowed: false, outcome: "mismatch" });
  });

  it("refuses an unknown caller when enforcing, but never for a host Hivra cannot read", async () => {
    expect(await checkKeyBinding({ ...base, caller: { address: null, via: "worker" } }, { db: db(managed), env: { HIVRA_MANAGED_KEY_BINDING: "enforce" } }))
      .toEqual({ allowed: false, outcome: "unknown_address" });
    resetKeyBindingCache();
    expect(await checkKeyBinding({ ...base, caller: { address: "198.51.100.7", via: "direct" } }, { db: db({ ...managed, proxmox_host: "nowhere" }), env: { HIVRA_MANAGED_KEY_BINDING: "enforce" } }))
      .toEqual({ allowed: true, outcome: "unknown_host" });
  });

  it("accepts extra host addresses from settings", async () => {
    const env = { HIVRA_MANAGED_KEY_BINDING: "enforce", HIVRA_MANAGED_KEY_BINDING_EXTRA_ADDRESSES: "203.0.113.12, nonsense" };
    expect(await checkKeyBinding({ ...base, caller: { address: "::ffff:203.0.113.12", via: "worker" } }, { db: db(managed), env })).toEqual({ allowed: true, outcome: "match" });
  });

  it("accepts a CIDR range such as a host's IPv6 /64", async () => {
    const env = { HIVRA_MANAGED_KEY_BINDING: "enforce", HIVRA_MANAGED_KEY_BINDING_EXTRA_ADDRESSES: "2001:db8:6a:48a9::/64" };
    expect(await checkKeyBinding({ ...base, caller: { address: "2001:db8:6a:48a9::1234", via: "direct" } }, { db: db(managed), env })).toEqual({ allowed: true, outcome: "match" });
    resetKeyBindingCache();
    expect(await checkKeyBinding({ ...base, caller: { address: "2001:db8:6a:48aa::1", via: "direct" } }, { db: db(managed), env })).toEqual({ allowed: false, outcome: "mismatch" });
  });

  it("leaves keys without a computer, and self-managed computers, unbound", async () => {
    const env = { HIVRA_MANAGED_KEY_BINDING: "enforce" };
    const away = { address: "198.51.100.7", via: "direct" as const };
    expect(await checkKeyBinding({ ...base, metadata: {}, caller: away }, { db: db(managed), env })).toEqual({ allowed: true, outcome: "unbound" });
    expect(await checkKeyBinding({ ...base, caller: away }, { db: db({ ...managed, deployment_mode: "self-managed" }), env })).toEqual({ allowed: true, outcome: "unbound" });
  });
});
