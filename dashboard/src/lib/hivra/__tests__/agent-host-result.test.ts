import { validateHivraHostRunningResult } from "../agent-host-result";

const token = "a".repeat(64);
const base = {
  expectedVmid: 401,
  expectedIp: "10.251.20.51",
  namedHostname: null,
  oneShotApiToken: null,
  existingApiToken: token,
};

describe("validateHivraHostRunningResult", () => {
  it("accepts an exact quick-tunnel receipt", () => {
    expect(validateHivraHostRunningResult({
      ...base,
      result: {
        ready: true,
        vmid: 401,
        ip: "10.251.20.51",
        chat_url: "https://valid-box.trycloudflare.com/",
      },
    })).toEqual({
      ok: true,
      value: {
        vmid: 401,
        ip: "10.251.20.51",
        chatUrl: "https://valid-box.trycloudflare.com",
        apiToken: token,
      },
    });
  });

  it.each([
    ["wrong VM", { vmid: 402, ip: "10.251.20.51", chat_url: "https://valid-box.trycloudflare.com" }],
    ["wrong IP", { vmid: 401, ip: "10.251.20.52", chat_url: "https://valid-box.trycloudflare.com" }],
    ["link-local SSRF", { vmid: 401, ip: "10.251.20.51", chat_url: "http://169.254.169.254/latest/meta-data" }],
    ["lookalike tunnel", { vmid: 401, ip: "10.251.20.51", chat_url: "https://trycloudflare.com.attacker.example" }],
  ])("rejects %s host output", (_label, receipt) => {
    expect(validateHivraHostRunningResult({
      ...base,
      result: { ready: true, ...receipt },
    }).ok).toBe(false);
  });

  it("requires the exact named hostname and a 64-hex token", () => {
    expect(validateHivraHostRunningResult({
      ...base,
      namedHostname: "box.example.test",
      existingApiToken: "not-a-token",
      result: {
        ready: true,
        vmid: 401,
        ip: "10.251.20.51",
        chat_url: "https://other.example.test",
      },
    }).ok).toBe(false);
  });

  it("requires an exact runtime identity when the caller names one", () => {
    expect(validateHivraHostRunningResult({
      ...base,
      expectedAgentKind: "linux-desktop",
      result: {
        ready: true,
        vmid: 401,
        ip: "10.251.20.51",
        agent_kind: "claude",
        chat_url: "https://valid-box.trycloudflare.com",
      },
    })).toEqual({ ok: false, reason: "agent_kind_mismatch" });
  });
});
