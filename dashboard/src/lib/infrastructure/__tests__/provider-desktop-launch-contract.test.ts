import { parseProviderDesktopLaunch, type ProviderDesktopLaunchAuthority } from "../provider-desktop-launch-contract";

const computerId = "11111111-1111-4111-8111-111111111111";
const tunnelId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const authority: ProviderDesktopLaunchAuthority = {
  computerId, controlOrigin: "https://canary.hermesos.cloud",
  access: { mode: "cloudflare-named", hostname: "desktop.example.com", tunnelId },
};
const token = (id: string) => Buffer.from(JSON.stringify({ t: id, s: "synthetic-test-only" })).toString("base64");
const launch = {
  version: 3, computerSubstrate: "provider-vm", agentKind: "linux-desktop", computerId,
  controlOrigin: authority.controlOrigin, publicOrigin: "https://desktop.example.com",
  wantBrowser: null, modelKey: "", modelBaseUrl: "", model: "", tunnelToken: token(tunnelId), accessHostname: null,
};
const error = "Provider desktop launch binding could not be verified";

it("binds a standalone desktop payload to the original computer, control origin and named tunnel", () => {
  expect(parseProviderDesktopLaunch(launch, authority)).toEqual(launch);
});
it("accepts an exact direct-HTTPS binding without a tunnel or bypass secret", () => {
  const hostname = "203-0-113-7.sslip.io";
  const direct = { ...launch, publicOrigin: `https://${hostname}`, accessHostname: hostname, tunnelToken: null };
  expect(parseProviderDesktopLaunch(direct, { ...authority, access: { mode: "direct-https", hostname, tunnelId: null } })).toEqual(direct);
});
it.each([
  { version: 1 }, { version: 2 }, { computerSubstrate: "proxmox-kvm" }, { agentKind: "codex" },
  { agentKind: "deepseek-harness" }, { computerId: otherId }, { controlOrigin: "https://other.example.com" },
  { publicOrigin: "https://other.example.com" }, { wantBrowser: true }, { wantBrowser: false },
  { modelKey: "synthetic-secret" }, { modelBaseUrl: "https://models.example.com" }, { model: "model" },
  { tunnelToken: null }, { tunnelToken: token(otherId) }, { tunnelToken: "not-json" },
  { accessHostname: "203-0-113-7.sslip.io" }, { controlBypassSecret: "synthetic-secret" },
])("rejects a swapped identity, agent launch or excess authority: %j", change => {
  expect(() => parseProviderDesktopLaunch({ ...launch, ...change }, authority)).toThrow(error);
});
it.each(["http://canary.hermesos.cloud", "https://canary.hermesos.cloud/", "https://user@canary.hermesos.cloud",
  "https://canary.hermesos.cloud:443", "https://canary.hermesos.cloud?x=1", "https://CANARY.hermesos.cloud",
  "https://localhost", "https://127.0.0.1", "https://xn--example.com"])("rejects a noncanonical control origin %s", controlOrigin => {
  expect(() => parseProviderDesktopLaunch({ ...launch, controlOrigin }, { ...authority, controlOrigin })).toThrow(error);
});
it.each(["203-0-113-007.sslip.io", "256-0-113-7.sslip.io", "203-0-113-7.sslip.io.attacker.com"])("rejects invalid direct identity %s", hostname => {
  expect(() => parseProviderDesktopLaunch({ ...launch, tunnelToken: null, accessHostname: hostname, publicOrigin: `https://${hostname}` },
    { ...authority, access: { mode: "direct-https", hostname, tunnelId: null } })).toThrow(error);
});
it("does not permit both or neither access mechanism in direct mode", () => {
  const hostname = "203-0-113-7.sslip.io";
  const expected = { ...authority, access: { mode: "direct-https" as const, hostname, tunnelId: null } };
  expect(() => parseProviderDesktopLaunch({ ...launch, publicOrigin: `https://${hostname}`, accessHostname: hostname }, expected)).toThrow(error);
  expect(() => parseProviderDesktopLaunch({ ...launch, publicOrigin: `https://${hostname}`, tunnelToken: null }, expected)).toThrow(error);
});
it("returns no credential-bearing diagnostics", () => {
  try { parseProviderDesktopLaunch({ ...launch, tunnelToken: "synthetic-secret", modelKey: "synthetic-model-key" }, authority); }
  catch (failure) {
    expect(String(failure)).toBe(`Error: ${error}`);
    return;
  }
  throw new Error("Expected rejection");
});
