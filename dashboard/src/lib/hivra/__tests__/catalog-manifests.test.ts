import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS, ALL_AGENTS, getAgent, hostingDisclaimer, resizeFloor } from "@/lib/hivra/agent-catalog";
import {
  buildCatalogAppLaunchSpec,
  CATALOG_APP_PORT_MAX,
  CATALOG_APP_PORT_MIN,
  CATALOG_OSI_LICENSES,
  catalogAppHostPort,
  catalogAppToAgentDef,
  CatalogAppManifestSchema,
  getCatalogAppManifest,
  isCatalogAppId,
  UNIVERSAL_CATALOG_IDS,
  UNIVERSAL_CATALOG_MANIFESTS,
} from "@/lib/hivra/catalog-manifests";
import { isUniversalCatalogEnabled } from "@/lib/hivra/universal-catalog-flag";
import { AGENT_WAKE_PROFILES } from "@/lib/hivra/agent-profiles/profiles";
import { agentSoftwareSubject, isAgentSoftwareVersion, parseAgentAppReport } from "@/lib/hivra/agent-cli-status";
import { LAUNCH_PROFILE_IDS, PROFILE_DETAILS } from "@/lib/launch/contracts";
import { LAUNCH_CATALOG } from "@/lib/launch/launch-catalog";
import { LAUNCH_RESOURCE_POLICY } from "@/lib/launch/resource-envelope";

describe("universal catalog feature flag", () => {
  it("stays off unless NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG is 1 or true", () => {
    expect(isUniversalCatalogEnabled(undefined)).toBe(false);
    expect(isUniversalCatalogEnabled("")).toBe(false);
    expect(isUniversalCatalogEnabled("0")).toBe(false);
    expect(isUniversalCatalogEnabled("1")).toBe(true);
    expect(isUniversalCatalogEnabled("TRUE")).toBe(true);
  });

  it("keeps universal catalog entries hidden from AGENTS when flag is off", () => {
    for (const id of UNIVERSAL_CATALOG_IDS) {
      expect(AGENTS.some((a) => a.id === id)).toBe(false);
      expect(ALL_AGENTS.some((a) => a.id === id)).toBe(true);
      expect(getAgent(id)?.available).toBe(false);
    }
  });
});

describe("universal catalog manifests", () => {
  it("matches UNIVERSAL_CATALOG_IDS and has unique slugs and ports in 3200-3999", () => {
    expect(UNIVERSAL_CATALOG_MANIFESTS.map((m) => m.id)).toEqual([...UNIVERSAL_CATALOG_IDS]);
    const ports = UNIVERSAL_CATALOG_MANIFESTS
      .map(catalogAppHostPort)
      .filter((p): p is number => p !== null);
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(CATALOG_APP_PORT_MIN);
      expect(port).toBeLessThanOrEqual(CATALOG_APP_PORT_MAX);
    }
  });

  it("keeps the STATUS.md catalog count in sync with the registry", () => {
    const status = readFileSync(resolve(__dirname, "../../../../../docs/STATUS.md"), "utf8");
    const match = /catalog now holds (\d+) entries/.exec(status);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(UNIVERSAL_CATALOG_MANIFESTS.length);
  });

  it("covers all four Wave 1 categories with OSI-approved open-source licenses only", () => {
    const categories = new Set(UNIVERSAL_CATALOG_MANIFESTS.map((m) => m.category));
    expect(categories).toEqual(new Set(["agent", "app"]));
    for (const manifest of UNIVERSAL_CATALOG_MANIFESTS) {
      expect(CATALOG_OSI_LICENSES).toContain(manifest.license);
      expect(manifest.sourceUrl).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(isCatalogAppId(manifest.id)).toBe(true);
      expect(getCatalogAppManifest(manifest.id)).toBe(manifest);
    }
  });

  it("rejects source-available licenses and unsafe container mount paths", () => {
    const base = UNIVERSAL_CATALOG_MANIFESTS.find((m) => m.id === "anythingllm")!;
    expect(() => CatalogAppManifestSchema.parse({ ...base, license: "BUSL-1.1" })).toThrow();
    expect(() => CatalogAppManifestSchema.parse({ ...base, license: "SSPL-1.0" })).toThrow();
    expect(() => CatalogAppManifestSchema.parse({ ...base, license: "NOASSERTION" })).toThrow();
    expect(() => CatalogAppManifestSchema.parse({
      ...base,
      runtime: {
        ...base.runtime,
        volumes: [{ name: "sock", mountPath: "/var/run/docker.sock" }],
      },
    })).toThrow();
    expect(() => CatalogAppManifestSchema.parse({
      ...base,
      runtime: {
        ...base.runtime,
        hostPort: 8080,
      },
    })).toThrow();
  });

  it("wires every manifest cleanly into Launch, resource policies, wake profiles, updates, and disclosures", () => {
    const wakeByType = new Map(AGENT_WAKE_PROFILES.map((p) => [p.type, p]));
    for (const manifest of UNIVERSAL_CATALOG_MANIFESTS) {
      const id = manifest.id as (typeof UNIVERSAL_CATALOG_IDS)[number];
      expect(LAUNCH_PROFILE_IDS).toContain(id);
      expect(PROFILE_DETAILS[id].placementRuntimeId).toBe("catalog-app");
      expect(PROFILE_DETAILS[id].runtimeId).toBe(id);
      expect(LAUNCH_CATALOG[id].sourceUrl).toBe(manifest.sourceUrl);
      expect(LAUNCH_RESOURCE_POLICY[id].floor).toEqual(manifest.floor);
      expect(resizeFloor(id, false)).toEqual(manifest.floor);
      expect(wakeByType.has(id)).toBe(true);

      const enabledDef = catalogAppToAgentDef(manifest, true);
      expect(enabledDef.available).toBe(true);
      // cli-web manifests with a chat surface must select the generic stream
      // adapter ("_text" events); every other shape stays undefined so the
      // default parser is never silently engaged for plain-text CLIs.
      const wantsGeneric = manifest.runtime.kind === "cli-web" && Boolean(manifest.runtime.cliChat);
      expect(enabledDef.cliKind).toBe(wantsGeneric ? "generic" : undefined);
      const managedCopy = hostingDisclaimer(enabledDef, "hivra-managed");
      expect(managedCopy).toContain("Hivra administrators retain infrastructure access");
      expect(managedCopy).not.toMatch(/[\u2013\u2014]/);
      const selfCopy = hostingDisclaimer(enabledDef, "self-managed");
      expect(selfCopy).toContain("Hivra does not become the host operator");

      const subject = agentSoftwareSubject({ type: id, computer_substrate: "proxmox-kvm" });
      expect(subject).toMatchObject({ type: id, app: id, gatewayKind: "catalog-app" });
      expect(isAgentSoftwareVersion(id, "sha256:" + "a".repeat(64))).toBe(true);
      expect(isAgentSoftwareVersion(id, "1.2.3")).toBe(true);
      expect(parseAgentAppReport(`HIVRA_AGENT_APP name=${id} version=1.2.3 target=latest state=current`)).toEqual({
        name: id,
        version: "1.2.3",
        target: "latest",
        state: "current",
      });

      const spec = buildCatalogAppLaunchSpec(manifest);
      expect(spec.appId).toBe(id);
      expect(spec.runtime).toEqual(manifest.runtime);
    }
  });

  it("has passing curator evidence for every manifest added after Wave 1", () => {
    // Wave 1 entries predate the deterministic verifier
    // (scripts/catalog-curator/verify-candidate.mjs); activepieces is
    // grandfathered with honestly failing evidence (GitHub reports
    // NOASSERTION). Every later manifest must carry a committed pass.
    const WAVE_1_IDS = new Set([
      "nanobot",
      "zeroclaw",
      "picoclaw",
      "opencode",
      "goose",
      "openhands",
      "anythingllm",
      "activepieces",
      "uptime-kuma",
      "gitea",
    ]);
    const evidenceDir = resolve(__dirname, "../../../../catalog-curation/evidence");
    for (const manifest of UNIVERSAL_CATALOG_MANIFESTS) {
      if (WAVE_1_IDS.has(manifest.id)) continue;
      const evidencePath = join(evidenceDir, `${manifest.id}.json`);
      expect(existsSync(evidencePath)).toBe(true);
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { verdict?: string };
      expect(evidence.verdict).toBe("pass");
    }
  });

  it("binds ezBookkeeping's required secret_key to a generated secret, never a literal", () => {
    // Upstream requires secret_key (env EBK_SECURITY_SECRET_KEY) set to a
    // random string before production use: it encrypts tokens and user 2FA
    // secrets, and the documented default must never serve a real deployment.
    // The manifest must wire it through the guest's generated-secret
    // mechanism — a literal in the repo would be worse than the default.
    const manifest = getCatalogAppManifest("ezbookkeeping");
    expect(manifest).toBeDefined();
    expect(manifest!.runtime.kind).toBe("docker-web");
    if (manifest!.runtime.kind !== "docker-web") return;
    const secretName = "EBK_SECRET_KEY_RAW";
    expect(manifest!.runtime.env?.EBK_SECURITY_SECRET_KEY).toBe(`\${${secretName}}`);
    expect(manifest!.runtime.generatedSecrets).toContain(secretName);
    // The whole manifest still parses under the launch schema.
    expect(() => CatalogAppManifestSchema.parse(manifest)).not.toThrow();
  });

  it("pins ZeroClaw to its configured-agent CLI shape and headless setup", () => {
    // Regression for the live Canary launch: `zeroclaw agent` requires a named
    // --agent alias plus configured risk/runtime/provider profiles, which the
    // setup commands create headlessly (quickstart is interactive-only).
    const zeroclaw = getCatalogAppManifest("zeroclaw");
    expect(zeroclaw?.runtime.kind).toBe("cli-web");
    if (zeroclaw?.runtime.kind !== "cli-web") return;
    expect(zeroclaw.runtime.cliChat?.args).toEqual(["agent", "--agent", "hivra", "-m"]);
    expect(zeroclaw.runtime.cliChat?.promptVia).toBe("arg");
    expect(zeroclaw.runtime.setup?.commands.length).toBeGreaterThanOrEqual(4);
    expect(zeroclaw.runtime.setup?.commands.join("\n")).toContain("agents create hivra");
    expect(zeroclaw.runtime.setup?.commands.join("\n")).toContain("agents.hivra.model_provider");
    expect(zeroclaw.runtime.setup?.commands.join("\n")).toContain("$OPENAI_API_KEY");
  });

  it("pins PicoClaw's launcher to the gateway port without opening a guest browser", () => {
    const picoclaw = getCatalogAppManifest("picoclaw");
    expect(picoclaw?.runtime.kind).toBe("cli-web");
    if (picoclaw?.runtime.kind !== "cli-web" || !picoclaw.runtime.webService) return;
    expect(picoclaw.runtime.webService.binName).toBe("picoclaw-launcher");
    expect(picoclaw.runtime.webService.args).toEqual([
      "-no-browser",
      "-host",
      "127.0.0.1",
      "-port",
      "3202",
    ]);
    expect(picoclaw.runtime.webService.hostPort).toBe(3202);
  });

  it("pins Sun-Panel to its last open-source release and mounts all three persistence paths", () => {
    // Upstream (hslr-s/sun-panel) went closed-source after v1.3.0 — its own
    // README states v1.3.0 is the latest open-source release — so floating
    // `latest` would pull closed-source images under an "MIT" license claim.
    // The manifest pins the Docker tag "1.3.0" (Docker Hub carries it without
    // the 'v' prefix), keeps the MIT claim accurate for exactly that image,
    // and mounts every directory v1.3.0 persists to (upstream's docker run
    // docs): /app/conf, /app/uploads and /app/database.
    const manifest = getCatalogAppManifest("sun-panel");
    expect(manifest).toBeDefined();
    expect(manifest!.license).toBe("MIT");
    expect(manifest!.runtime.kind).toBe("docker-web");
    if (manifest!.runtime.kind !== "docker-web") return;
    expect(manifest!.runtime.imageRepo).toBe("hslr/sun-panel");
    expect(manifest!.runtime.imageTag).toBe("1.3.0");
    expect(manifest!.runtime.volumes).toEqual([
      { name: "conf", mountPath: "/app/conf" },
      { name: "uploads", mountPath: "/app/uploads" },
      { name: "database", mountPath: "/app/database" },
    ]);
    // The copy must not oversell: it names the pinned release and its
    // open-source status rather than implying current releases are MIT.
    expect(manifest!.description).toContain("1.3.0");
    expect(manifest!.seo?.summary).toContain("open-source");
    expect(() => CatalogAppManifestSchema.parse(manifest)).not.toThrow();
  });
});
