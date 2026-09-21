import { firstBootFirewallRequest, firstBootFirewallReceipt } from "../first-boot-firewall";

export function firstBootFirewallFixture() {
  const scope = {
    orderId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    quoteFingerprint: "a".repeat(64), serverId: 42,
  };
  const request = firstBootFirewallRequest(scope);
  const firewall = {
    id: 61, name: request.name, labels: request.labels, created: "2026-08-27T17:00:00Z",
    rules: request.rules.map(rule => ({ ...rule, destination_ips: [] as string[], description: null })),
    applied_to: request.apply_to,
  };
  const setRulesAction = { id: 81, command: "set_firewall_rules", status: "success",
    resources: [{ id: 61, type: "firewall" }] };
  const applyAction = { id: 82, command: "apply_firewall", status: "success",
    resources: [{ id: 42, type: "server" }, { id: 61, type: "firewall" }] };
  const response = { firewall, actions: [setRulesAction, applyAction] };
  const receipt = firstBootFirewallReceipt(scope, response);
  const server = { id: 42, status: "off", locked: false,
    public_net: { firewalls: [{ id: 61, status: "applied" }] } };
  return { scope, request, response, receipt, firewall, setRulesAction, applyAction, server };
}
