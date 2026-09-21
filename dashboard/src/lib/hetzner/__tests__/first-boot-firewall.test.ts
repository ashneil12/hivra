import {
  assessFirstBootFirewall, assessEnrolledGuestFirewall, assertFirstBootFirewallUnattached, firstBootFirewallReceipt,
  firstBootFirewallRequest, firstBootPowerOnAction, parseFirstBootFirewallReceipt, assertFirstBootFirewallCleanup,
} from "../first-boot-firewall";
import { firstBootFirewallFixture } from "./first-boot-firewall.fixtures";

describe("exact first-boot firewall policy", () => {
  it("preserves exact legacy SSH-only lifecycle and cleanup without admitting it for direct HTTPS", () => {
    const f = firstBootFirewallFixture();
    f.firewall.rules = f.firewall.rules.filter(rule => rule.port === "22");
    expect(assessFirstBootFirewall(f)).toBe("firewall_verified");
    expect(() => assessFirstBootFirewall({ ...f, requireHttps: true })).toThrow("resource_changed");
    expect(() => firstBootFirewallReceipt(f.scope, { ...f.response, firewall: f.firewall })).toThrow("resource_changed");
    expect(() => assertFirstBootFirewallCleanup(f)).not.toThrow();
    f.firewall.applied_to = [];
    expect(() => assertFirstBootFirewallUnattached(f)).not.toThrow();
  });
  it("keeps off-only boot admission distinct from running enrolled-guest verification",()=>{
    const f=firstBootFirewallFixture();
    expect(assessFirstBootFirewall(f)).toBe("firewall_verified");
    expect(()=>assessEnrolledGuestFirewall(f)).toThrow("resource_changed");
    f.server.status="running";
    expect(()=>assessFirstBootFirewall(f)).toThrow("resource_changed");
    expect(assessEnrolledGuestFirewall(f)).toBe("firewall_verified");
    f.server.public_net.firewalls[0].id=62;
    expect(()=>assessEnrolledGuestFirewall(f)).toThrow("resource_changed");
  });
  it("renders key-auth SSH and standalone HTTPS ingress on the one server, without a label selector", () => {
    const f = firstBootFirewallFixture();
    expect(f.request.rules).toEqual(["22", "80", "443"].map(port => ({ direction: "in", protocol: "tcp", port,
      source_ips: ["0.0.0.0/0", "::/0"] })));
    expect(f.request.apply_to).toEqual([{ type: "server", server: { id: 42 } }]);
    expect(f.request.labels).toEqual({ "hivra-operation": f.scope.orderId, "hivra-attempt": f.scope.attemptId,
      "hivra-quote": "a".repeat(32), "hivra-managed": "true" });
  });

  it.each([
    { serverId: 0 }, { serverId: 1.5 }, { serverId: Number.MAX_SAFE_INTEGER + 1 },
    { orderId: "not-a-uuid" }, { attemptId: "00000000-0000-0000-0000-000000000000" },
    { quoteFingerprint: "x".repeat(64) }, { rules: [] },
  ])("rejects invalid or widened scope before building a request: %j", changed => {
    const f = firstBootFirewallFixture();
    expect(() => firstBootFirewallRequest({ ...f.scope, ...changed })).toThrow("invalid_scope");
  });

  it("receipts original IDs, not progress, error text, credentials or unknown metadata", () => {
    const f = firstBootFirewallFixture();
    const receipt = firstBootFirewallReceipt(f.scope, { ...f.response, token: "must-not-copy",
      actions: f.response.actions.map(a => ({ ...a, progress: 100, error: { message: "secret" } })) });
    expect(receipt).toEqual({ version: 1, scope: f.scope, firewallId: 61, createdAt: "2026-08-27T17:00:00Z",
      setRulesActionId: 81, applyActionId: 82 });
    expect(JSON.stringify(receipt)).not.toMatch(/secret|progress|token|resources/);
  });

  it("does not confuse an accepted create with a completed firewall", () => {
    const f = firstBootFirewallFixture();
    f.response.actions.forEach(a => { a.status = "running"; });
    f.firewall.applied_to = [];
    f.server.public_net.firewalls = [];
    expect(firstBootFirewallReceipt(f.scope, f.response)).toEqual(f.receipt);
    expect(assessFirstBootFirewall(f)).toBe("pending");
  });

  it("allows equivalent source/resource/label ordering and timestamp representation", () => {
    const f = firstBootFirewallFixture();
    f.firewall.rules.reverse(); f.firewall.rules[0].source_ips.reverse(); f.applyAction.resources.reverse();
    f.firewall.labels = Object.fromEntries(Object.entries(f.firewall.labels).reverse()) as typeof f.firewall.labels;
    f.firewall.created = "2026-08-27T18:00:00+01:00";
    expect(assessFirstBootFirewall(f)).toBe("firewall_verified");
  });

  it.each(["orderId", "attemptId", "quoteFingerprint", "serverId"] as const)("binds a receipt to current %s", key => {
    const f = firstBootFirewallFixture();
    const scope = { ...f.scope, [key]: key === "serverId" ? 43 : key === "quoteFingerprint" ? "b".repeat(64)
      : "33333333-3333-4333-8333-333333333333" };
    expect(() => parseFirstBootFirewallReceipt(f.receipt, scope)).toThrow("invalid_receipt");
  });

  it.each([
    ["changed firewall ID", (f: ReturnType<typeof firstBootFirewallFixture>) => { f.firewall.id = 62; }],
    ["changed creation time", f => { f.firewall.created = "2026-08-27T17:01:00Z"; }],
    ["renamed firewall", f => { f.firewall.name = "other"; }],
    ["changed labels", f => { f.firewall.labels["hivra-quote"] = "b".repeat(32); }],
    ["extra allow rule", f => { f.firewall.rules.push({ ...f.firewall.rules[0] }); }],
    ["duplicate source", f => { f.firewall.rules[0].source_ips = ["::/0", "::/0"]; }],
    ["outbound rule", f => { f.firewall.rules[0].direction = "out" as never; }],
    ["different SSH sources", f => { f.firewall.rules[0].source_ips[0] = "192.0.2.1/32"; }],
    ["different target", f => { f.firewall.applied_to[0].server.id = 43; }],
    ["second target", f => { f.firewall.applied_to.push({ type: "server", server: { id: 43 } }); }],
    ["changed action ID", f => { f.applyAction.id = 83; }],
    ["wrong action target", f => { f.applyAction.resources[0].id = 43; }],
    ["duplicate resources", f => { f.applyAction.resources[0] = { ...f.applyAction.resources[1] }; }],
    ["wrong action command", f => { f.applyAction.command = "remove_firewall"; }],
    ["unexpected attached firewall", f => { f.server.public_net.firewalls.push({ id: 62, status: "applied" }); }],
    ["different firewall on server", f => { f.server.public_net.firewalls[0].id = 62; }],
    ["removing attachment", f => { f.server.public_net.firewalls[0].status = "removing"; }],
    ["running server", f => { f.server.status = "running"; }],
    ["other server", f => { f.server.id = 43; }],
  ] satisfies Array<[string, (fixture: ReturnType<typeof firstBootFirewallFixture>) => void]>)("rejects %s even with a concurrent transient", (_name, mutate) => {
    const f = firstBootFirewallFixture(); f.server.locked = true; mutate(f);
    expect(() => assessFirstBootFirewall(f)).toThrow("resource_changed");
  });

  it("rejects selectors even with no currently matching servers", () => {
    const f = firstBootFirewallFixture();
    const firewall = { ...f.firewall, applied_to: [{ type: "label_selector", label_selector: { selector: "all=true" }, applied_to_resources: [] }] };
    expect(() => assessFirstBootFirewall({ ...f, firewall })).toThrow("resource_changed");
    expect(() => assertFirstBootFirewallUnattached({ ...f, firewall })).toThrow("resource_changed");
  });

  it("accepts explicitly null selector metadata but never an active hidden selector", () => {
    const f = firstBootFirewallFixture();
    const attachment = { ...f.firewall.applied_to[0], label_selector: null, applied_to_resources: [] };
    const firewall = { ...f.firewall, applied_to: [attachment] };
    expect(assessFirstBootFirewall({ ...f, firewall })).toBe("firewall_verified");
    const hiddenSelector = { ...attachment, label_selector: { selector: "all=true" } };
    expect(() => assessFirstBootFirewall({ ...f, firewall: { ...firewall, applied_to: [hiddenSelector] } }))
      .toThrow("resource_changed");
  });

  it("rejects missing nested firewall evidence and ignores a top-level decoy", () => {
    const f = firstBootFirewallFixture();
    const server = { ...f.server, public_net: {}, firewalls: [{ id: 61, status: "applied" }] };
    expect(() => assessFirstBootFirewall({ ...f, server })).toThrow("resource_changed");
  });

  it.each(["setRulesAction", "applyAction", "locked", "missingFirewallTarget", "missingServerAttachment", "pendingAttachment"])("waits on intact transient %s", stage => {
    const f = firstBootFirewallFixture();
    if (stage === "setRulesAction" || stage === "applyAction") f[stage].status = "running";
    else if (stage === "locked") f.server.locked = true;
    else if (stage === "missingFirewallTarget") f.firewall.applied_to = [];
    else if (stage === "missingServerAttachment") f.server.public_net.firewalls = [];
    else f.server.public_net.firewalls[0].status = "pending";
    expect(assessFirstBootFirewall(f)).toBe("pending");
  });

  it.each(["setRulesAction", "applyAction"] as const)("retains a failed original %s receipt but forbids boot", key => {
    const f = firstBootFirewallFixture(); f[key].status = "error"; f.server.locked = true;
    expect(firstBootFirewallReceipt(f.scope, f.response)).toEqual(f.receipt);
    expect(() => assessFirstBootFirewall(f)).toThrow("action_failed");
  });

  it.each([0, 1, 3])("rejects %s actions rather than adopting an incomplete or extended receipt", count => {
    const f = firstBootFirewallFixture();
    const actions = [...f.response.actions, f.applyAction].slice(0, count);
    expect(() => firstBootFirewallReceipt(f.scope, { ...f.response, actions })).toThrow("invalid_receipt");
  });

  it("rejects duplicate action IDs", () => {
    const f = firstBootFirewallFixture(); f.applyAction.id = f.setRulesAction.id;
    expect(() => firstBootFirewallReceipt(f.scope, f.response)).toThrow("invalid_receipt");
  });

  it("requires the exact owned firewall to be unattached before cleanup", () => {
    const f = firstBootFirewallFixture();
    expect(() => assertFirstBootFirewallUnattached(f)).toThrow("still_attached");
    f.firewall.applied_to = [];
    expect(() => assertFirstBootFirewallUnattached(f)).not.toThrow();
    f.firewall.id = 62;
    expect(() => assertFirstBootFirewallUnattached(f)).toThrow("resource_changed");
  });

  it("validates the provider's start_server action, not the poweron endpoint name", () => {
    const action = { id: 91, command: "start_server", status: "running", resources: [{ id: 42, type: "server" }] };
    expect(firstBootPowerOnAction(42, action)).toEqual(action);
    expect(() => firstBootPowerOnAction(43, action)).toThrow("resource_changed");
    expect(() => firstBootPowerOnAction(42, { ...action, command: "poweron" })).toThrow("resource_changed");
  });
});
