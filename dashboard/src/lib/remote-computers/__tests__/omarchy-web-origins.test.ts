jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  resolveOmarchyWebBrokerOrigin,
  resolveOmarchyWebControlOrigin,
} from "../omarchy-native-capability";
import type { OmarchyNativePreparationRequest } from "../omarchy-native-preparation-host";

const CANARY_BROKER_ORIGIN = "https://omarchy-canary.hermesos.cloud";
const CANARY_CONTROL_ORIGIN = "https://canary.hermesos.cloud";

const request: OmarchyNativePreparationRequest = {
  computerId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  vmid: 2096,
  guestPrivateIpv4: "10.240.20.97",
};
const BINDING_TAG = "hivra-bind-" + "9".repeat(32);

const envOf = (vars: Record<string, string | undefined>) => (
  { NODE_ENV: "test" as const, ...vars });

/** The origins are read when the module loads, so a configured deployment is
 * exercised by loading it under that environment. */
function loadWith(vars: Record<string, string | undefined>) {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    jest.resetModules();
    return {
      capability: require("../omarchy-native-capability") as typeof import("../omarchy-native-capability"),
      host: require("../omarchy-native-preparation-host") as typeof import("../omarchy-native-preparation-host"),
    };
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Omarchy desktop web origins", () => {
  it("keeps the retained Canary origins when the deployment configures none", async () => {
    const { capability, host } = loadWith({
      HIVRA_OMARCHY_WEB_BROKER_ORIGIN: undefined,
      HIVRA_OMARCHY_WEB_CONTROL_ORIGIN: undefined,
    });
    expect(capability.OMARCHY_WEB_BROKER_ORIGIN).toBe(CANARY_BROKER_ORIGIN);
    expect(capability.OMARCHY_WEB_CONTROL_ORIGIN).toBe(CANARY_CONTROL_ORIGIN);

    const bundle = await host.loadOmarchyNativeGuardianBundle();
    const script = host.buildOmarchyNativePreparationHostScript(request, BINDING_TAG, bundle);
    expect(script).toContain(CANARY_BROKER_ORIGIN);
    expect(script).toContain(CANARY_CONTROL_ORIGIN);
  });

  // The guest is prepared for the deployment that will front it: production
  // fronts its own guest on its own origin, and the receipt is checked against
  // that same origin rather than the Canary one.
  it("writes a deployment's own origins into the guest preparation and verifies against them", async () => {
    const { capability, host } = loadWith({
      HIVRA_OMARCHY_WEB_BROKER_ORIGIN: "https://omarchy.hermesos.cloud",
      HIVRA_OMARCHY_WEB_CONTROL_ORIGIN: "https://hivra.cloud",
    });
    expect(capability.OMARCHY_WEB_BROKER_ORIGIN).toBe("https://omarchy.hermesos.cloud");
    expect(capability.OMARCHY_WEB_CONTROL_ORIGIN).toBe("https://hivra.cloud");

    const bundle = await host.loadOmarchyNativeGuardianBundle();
    const script = host.buildOmarchyNativePreparationHostScript(request, BINDING_TAG, bundle);
    // The request the guest installer receives, and the receipt it is checked
    // against, both carry this deployment's origins.
    expect(script).toContain("https://omarchy.hermesos.cloud");
    expect(script).toContain("https://hivra.cloud");
    expect(script).not.toContain(CANARY_BROKER_ORIGIN);
    expect(script).not.toContain(CANARY_CONTROL_ORIGIN);
  });

  it("refuses an origin outside our own domains instead of writing it into a guest", () => {
    expect(() => resolveOmarchyWebBrokerOrigin(envOf({ HIVRA_OMARCHY_WEB_BROKER_ORIGIN: "https://evil.example" })))
      .toThrow(/HIVRA_OMARCHY_WEB_BROKER_ORIGIN/);
    expect(() => resolveOmarchyWebControlOrigin(envOf({ HIVRA_OMARCHY_WEB_CONTROL_ORIGIN: "http://hivra.cloud" })))
      .toThrow(/HIVRA_OMARCHY_WEB_CONTROL_ORIGIN/);
    expect(resolveOmarchyWebBrokerOrigin(envOf({ HIVRA_OMARCHY_WEB_BROKER_ORIGIN: "https://omarchy.hivra.cloud" })))
      .toBe("https://omarchy.hivra.cloud");
    expect(resolveOmarchyWebControlOrigin(envOf({}))).toBe(CANARY_CONTROL_ORIGIN);
  });

  // The guest-side installer and the capability probe each run inside the guest,
  // so each carried its own copy of the Canary pair. A desktop on any other
  // deployment was refused by the installer ("input_origin") or failed its probe
  // even after the host script had been given the right origins.
  it("keeps the guest-side installer and probe deployment-neutral", () => {
    const installer = readFileSync(
      path.join(process.cwd(), "provisioner", "remote-desktop", "install-omarchy-web.py"), "utf8");
    expect(installer).not.toContain('!= "https://canary.hermesos.cloud"');
    expect(installer).not.toContain('Host: omarchy-canary.hermesos.cloud');
    expect(installer).toMatch(/own_origin = r"https:\/\/.*\(hermesos\|hivra\)/);
    expect(installer).toContain('public_host = request["publicOrigin"].split("//", 1)[-1]');
  });

  it("makes the capability probe deployment-specific", () => {
    const retained = loadWith({}).capability.OMARCHY_NATIVE_INSPECTION_REVISION;
    const production = loadWith({
      HIVRA_OMARCHY_WEB_BROKER_ORIGIN: "https://omarchy.hermesos.cloud",
      HIVRA_OMARCHY_WEB_CONTROL_ORIGIN: "https://hivra.cloud",
    }).capability.OMARCHY_NATIVE_INSPECTION_REVISION;
    expect(production).not.toBe(retained);
  });
});
