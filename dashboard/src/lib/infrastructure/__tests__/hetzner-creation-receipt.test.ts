import type { HetznerAction, HetznerServer } from "@/lib/hetzner/client";
import {
  assertHetznerCreationReceiptMatchesObservation,
  createHetznerCreationReceipt,
  HetznerCreationReceiptSchema,
} from "../hetzner-creation-receipt";

const server = {
  id: 42,
  image: { id: 100 },
  public_net: {
    ipv4: { id: 88, ip: "203.0.113.10" },
    ipv6: { id: 89, ip: "2001:db8::/64" },
  },
} as HetznerServer;
const main: HetznerAction = {
  id: 500, command: "create_server", status: "running",
  resources: [{ id: 42, type: "server" }],
};
const next: HetznerAction = {
  id: 501, command: "create_primary_ip", status: "running",
  resources: [{ id: 88, type: "primary_ip" }],
};
const receipt = () => createHetznerCreationReceipt(server, main, [next]);

describe("private Hetzner creation resource receipts", () => {
  it.each([false, true])("validates the source image without adding image ownership (image first: %s)", imageFirst => {
    const resources = [{ id: 42, type: "server" }, { id: 100, type: "image" }];
    if (imageFirst) resources.reverse();
    const action = { ...main, resources };
    const originalResources = structuredClone(resources);
    expect(createHetznerCreationReceipt(server, action, [next])).toEqual(receipt());
    expect(action.resources).toEqual(originalResources);
    expect(() => assertHetznerCreationReceiptMatchesObservation(receipt(), server,
      { ...action, status: "success" }, [next])).not.toThrow();
  });

  it.each([
    [{ id: 42, type: "server" }, { id: 101, type: "image" }],
    [{ id: 42, type: "server" }, { id: 100, type: "image" }, { id: 100, type: "image" }],
    [{ id: 42, type: "server" }, { id: 42, type: "server" }],
    [{ id: 100, type: "image" }],
    [{ id: 43, type: "server" }, { id: 100, type: "image" }],
    [{ id: 42, type: "server" }, { id: 100, type: "volume" }],
    [{ id: 42, type: "server" }, { id: 88, type: "primary_ip" }],
    [{ id: 42, type: "server" }, { id: Number.MAX_SAFE_INTEGER + 1, type: "image" }],
  ])("rejects unrelated or duplicate source image action resources %#", (...resources) => {
    expect(() => createHetznerCreationReceipt(server, { ...main, resources }, [next])).toThrow();
  });

  it("records exactly the initial server, both Primary IPs, and action resources", () => {
    expect(receipt()).toEqual({
      version: 1, serverId: "42",
      primaryIpv4: { id: "88", ip: "203.0.113.10" },
      primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { ...main, id: "500", resources: [{ id: "42", type: "server" }] },
      nextActions: [{ ...next, id: "501", resources: [{ id: "88", type: "primary_ip" }] }],
    });
  });

  it.each([
    ["missing IPv4 ID", { ipv4: { ip: "203.0.113.10" } }],
    ["missing IPv6", { ipv6: null }],
    ["duplicate IDs", { ipv6: { id: 88, ip: "2001:db8::/64" } }],
    ["unsafe ID", { ipv4: { id: Number.MAX_SAFE_INTEGER + 1, ip: "203.0.113.10" } }],
    ["invalid IPv4", { ipv4: { id: 88, ip: "not-an-address" } }],
    ["noncanonical IPv4", { ipv4: { id: 88, ip: "0203.0.113.4" } }],
    ["scoped IPv6", { ipv6: { id: 89, ip: "fe80::1%eth0/64" } }],
    ["wrong IPv6 prefix", { ipv6: { id: 89, ip: "2001:db8::/128" } }],
  ])("rejects incomplete ownership: %s", (_name, patch) => {
    expect(() => createHetznerCreationReceipt({
      ...server, public_net: { ...server.public_net, ...patch },
    } as HetznerServer, main, [next])).toThrow();
  });

  it.each([
    { resources: [{ id: 999, type: "primary_ip" }] },
    { resources: [{ id: 88, type: "volume" }] },
    { resources: [] },
    { resources: [{ id: 88, type: "primary_ip" }, { id: 88, type: "primary_ip" }] },
    { id: 500 },
    { command: "poweron" },
  ])("rejects an unrelated or unsafe create action %#", (patch) => {
    expect(() => createHetznerCreationReceipt(server, main, [{ ...next, ...patch }])).toThrow();
  });

  it("does not retain extraneous provider fields or credentials", () => {
    const value = createHetznerCreationReceipt(
      { ...server, root_password: "must-not-store" } as HetznerServer,
      { ...main, raw: "must-not-store" } as HetznerAction, [next],
    );
    expect(JSON.stringify(value)).not.toContain("must-not-store");
    expect(HetznerCreationReceiptSchema.safeParse({ ...value, token: "unexpected" }).success).toBe(false);
  });

  it("allows action status transitions without changing the original receipt", () => {
    const original = receipt();
    assertHetznerCreationReceiptMatchesObservation(original, server,
      { ...main, status: "success" }, [{ ...next, status: "success" }]);
    expect(original.action.status).toBe("running");
  });

  it.each([
    { ipv4: { id: 100, ip: "203.0.113.10" } },
    { ipv4: { id: 88, ip: "203.0.113.20" } },
    { ipv6: { id: 100, ip: "2001:db8::/64" } },
    { ipv6: { id: 89, ip: "2001:db8:1::/64" } },
  ])("rejects a later swapped IP even if the server still matches its quote %#", (patch) => {
    expect(() => assertHetznerCreationReceiptMatchesObservation(receipt(), {
      ...server, public_net: { ...server.public_net, ...patch },
    } as HetznerServer, main, [next])).toThrow();
  });

  it("rejects changed action resource membership even within the same IP pair", () => {
    expect(() => assertHetznerCreationReceiptMatchesObservation(receipt(), server, main,
      [{ ...next, resources: [{ id: 89, type: "primary_ip" }] }])).toThrow();
  });

  it("rejects a changed source image during later receipt comparison", () => {
    expect(() => assertHetznerCreationReceiptMatchesObservation(receipt(), server, {
      ...main, resources: [...main.resources, { id: 101, type: "image" }],
    }, [next])).toThrow();
  });
});
