/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { deleteBoxTunnelVerified } from "../cloudflare-tunnel-cleanup";

const config = {
  apiToken: "private-test-token", accountId: "a".repeat(32),
  zoneId: "b".repeat(32), domain: "example.test",
};
const resource = { tunnelId: "11111111-1111-4111-8111-111111111111", hostname: "box.example.test" };
const dns = { id: "c".repeat(32), name: resource.hostname, type: "CNAME", content: `${resource.tunnelId}.cfargotunnel.com` };
const tunnel = { id: resource.tunnelId, account_tag: config.accountId, connections: [], deleted_at: null };
const removed = { ...tunnel, deleted_at: "2026-08-27T03:00:00Z" };
const mockFetch = jest.fn();
const originalFetch = global.fetch;
function response(result: unknown, result_info?: unknown) {
  return { ok: true, json: async () => ({ success: true, result, ...(result_info ? { result_info } : {}) }) };
}
function dnsResponse(records: unknown[] = []) {
  return response(records, { page: 1, count: records.length, total_count: records.length, total_pages: 1 });
}
function initial(records: unknown[] = [dns], observedTunnel: Record<string, unknown> = tunnel) {
  mockFetch.mockResolvedValueOnce(response({ name: config.domain, account: { id: config.accountId } }))
    .mockResolvedValueOnce(response(observedTunnel))
    .mockResolvedValueOnce(dnsResponse(records));
}
const mutations = () => mockFetch.mock.calls.filter(([, opts]) => opts.method === "DELETE");

beforeEach(() => { mockFetch.mockReset(); global.fetch = mockFetch; });
afterAll(() => { global.fetch = originalFetch; });

it("verifies exact tunnel and DNS absence after deletion", async () => {
  initial();
  mockFetch.mockResolvedValueOnce(response({ id: dns.id }))
    .mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response(removed))
    .mockResolvedValueOnce(response(removed)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(dnsResponse());
  await expect(deleteBoxTunnelVerified(resource, config)).resolves.toBeUndefined();
  expect(mutations().map(([url]) => url)).toEqual([
    `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/dns_records/${dns.id}`,
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/cfd_tunnel/${resource.tunnelId}/connections`,
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/cfd_tunnel/${resource.tunnelId}`,
  ]);
  expect(mockFetch.mock.calls.every(([, opts]) => opts.signal instanceof AbortSignal && opts.redirect === "error")).toBe(true);
});

it("is idempotent when a previous attempt removed both resources", async () => {
  initial([], removed);
  mockFetch.mockResolvedValueOnce(response(removed)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(dnsResponse());
  await deleteBoxTunnelVerified(resource, config);
  expect(mutations()).toHaveLength(0);
});

it("allows agents that never had a named tunnel without provider configuration", async () => {
  await deleteBoxTunnelVerified({}, null);
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  [{ ...resource, tunnelId: null }, config, "resource_identity"],
  [{ ...resource, hostname: null }, config, "resource_identity"],
  [{ ...resource, tunnelId: "../other" }, config, "resource_identity"],
  [resource, null, "configuration"],
])("fails closed on missing authority %j", async (identity, cfg, stage) => {
  await expect(deleteBoxTunnelVerified(identity, cfg)).rejects.toMatchObject({ stage });
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  { ...dns, content: "someone-else.example.test" },
  { ...dns, name: "another.example.test" },
  { ...dns, type: "A", content: "192.0.2.1" },
  { ...dns, id: "../other" },
])("never deletes foreign or malformed DNS records %j", async (record) => {
  initial([record]);
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "dns_ownership" });
  expect(mutations()).toHaveLength(0);
});

it("refuses a mismatched account before any mutation", async () => {
  mockFetch.mockResolvedValueOnce(response({ name: config.domain, account: { id: "d".repeat(32) } }));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "zone_identity" });
  expect(mutations()).toHaveLength(0);
});

it.each([null, {}, { page: 1, count: 0, total_count: 1, total_pages: 2 }])(
  "does not mistake missing or truncated DNS evidence for absence %j", async (info) => {
    mockFetch.mockResolvedValueOnce(response({ name: config.domain, account: { id: config.accountId } }))
      .mockResolvedValueOnce(response(tunnel)).mockResolvedValueOnce(response([], info));
    await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "dns_evidence" });
    expect(mutations()).toHaveLength(0);
  },
);

it.each([401, 403, 404, 429, 500])("fails closed on provider HTTP %d without exposing credentials", async (status) => {
  mockFetch.mockResolvedValue({ ok: false, status, json: async () => ({ success: false, errors: [{ message: config.apiToken }] }) });
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toThrow("Cloudflare cleanup could not be verified (zone_read).");
  expect(mutations()).toHaveLength(0);
});

it("does not mark access removed when a DELETE fails", async () => {
  initial();
  mockFetch.mockRejectedValueOnce(new Error("private-test-token"));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "dns_delete" });
  expect(mutations()).toHaveLength(1);
});

it("requires a deleted_at timestamp", async () => {
    initial([]);
    mockFetch.mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response(removed))
      .mockResolvedValueOnce(response(tunnel));
    await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "tunnel_still_present" });
});

it.each([[{ id: "connector" }], null, {}])("uses dedicated connection evidence, not deprecated empty tunnel metadata %j", async (connections) => {
  initial([], removed);
  mockFetch.mockResolvedValueOnce(response(removed)).mockResolvedValueOnce(response(connections));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "connections_still_present" });
});

it("fails closed if the dedicated connections query fails", async () => {
  initial([], removed);
  mockFetch.mockResolvedValueOnce(response(removed)).mockRejectedValueOnce(new Error("unavailable"));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "connections_read" });
});

it.each([{ count: 1 }, { total_count: 2 }, { page: 2 }, { total_pages: 3 }])("rejects contradictory connections pagination %j", async (info) => {
  initial([], removed);
  mockFetch.mockResolvedValueOnce(response(removed)).mockResolvedValueOnce(response([], info));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "connections_still_present" });
});

it("verifies DNS again even after a successful delete response", async () => {
  initial([]);
  mockFetch.mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response(removed))
    .mockResolvedValueOnce(response(removed)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(dnsResponse([dns]));
  await expect(deleteBoxTunnelVerified(resource, config)).rejects.toMatchObject({ stage: "dns_still_present" });
});
