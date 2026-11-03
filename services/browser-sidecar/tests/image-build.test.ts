import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MIN_CHROMIUM_VERSION } from "../src/browser/chromium.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");
const workflowText = () => read(repoRoot, ".github", "workflows", "browser-sidecar.yml");
type Step = Record<string, unknown> & { name?: string; run?: string; if?: string };

describe("browser-sidecar image build contract", () => {
  it("tests, builds and sandbox-checks the image before anything is published", () => {
    const jobs = parse(workflowText()).jobs as Record<string, { needs?: string; if?: string; steps: Step[] }>;
    expect(jobs.image.needs).toBe("test");
    expect(jobs.publish.needs).toBe("image");
    expect(jobs.publish.if).toBe("github.event_name == 'push'");

    const testRuns = jobs.test.steps.map((step) => step.run);
    expect(testRuns).toEqual(expect.arrayContaining(["npm ci --no-audit --no-fund", "npm run lint", "npm test"]));

    const imageSteps = jobs.image.steps;
    const names = imageSteps.map((step) => step.name);
    const build = names.indexOf("Build image");
    const policy = names.indexOf("Match the customer VMs' user-namespace policy");
    const sandbox = names.indexOf("Sandbox regression (sandbox ON, patched Chromium, fails closed)");
    const save = names.indexOf("Save tested image");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThan(build);
    expect(sandbox).toBeGreaterThan(policy);
    expect(save).toBeGreaterThan(sandbox);
    expect(imageSteps[policy].run).toContain("sysctl -w kernel.apparmor_restrict_unprivileged_userns=1");
    expect(imageSteps[sandbox].run).toBe('bash tests/sandbox/run-image-checks.sh "$IMAGE"');
    for (const step of [...jobs.test.steps, ...imageSteps, ...jobs.publish.steps]) {
      expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  it("publishes only the tested bytes, only under immutable sha- tags, and never moves :stable", () => {
    const text = workflowText();
    const publish = (parse(text).jobs.publish.steps as Step[]).find((step) => step.name === "Push immutable sha tag")!;
    expect(publish.run).toContain('docker load');
    expect(publish.run).toContain('target="ghcr.io/ashneil12/${package_name}:sha-${SHA}"');
    expect(publish.run).toContain('package_name="hermes-browser-sidecar-canary"');
    expect(publish.run).toContain('package_name="hermes-browser-sidecar"');
    expect(publish.run).toContain('refusing to publish from');
    expect(text).not.toMatch(/:stable["'\s]*$/m);
    expect(text).not.toMatch(/docker (tag|push)[^\n]*:stable/);
    // github.* values reach the shell through env, never `${{ }}` inside run:
    // (template-injection hardening).
    for (const step of parse(text).jobs.publish.steps as Step[]) {
      expect(step.run ?? "").not.toContain("${{");
    }
  });

  it("uses the committed lockfile for Docker and CI dependency installs", () => {
    const dockerfile = read(packageRoot, "Dockerfile");
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev --no-audit --no-fund");
    expect(dockerfile).toContain("npm ci --no-audit --no-fund");
    expect(dockerfile).not.toContain("npm install");
    expect(workflowText()).toContain("run: npm ci --no-audit --no-fund");
  });

  it("pins every external base image to an immutable multi-platform digest", () => {
    const fromLines = read(packageRoot, "Dockerfile").split(/\r?\n/).filter((line) => line.startsWith("FROM "));
    const base = "node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f";
    expect(fromLines).toEqual([`FROM ${base} AS deps`, `FROM ${base} AS build`, `FROM ${base} AS runtime`]);
  });
});

describe("browser-sidecar Chromium is patched and sandboxed", () => {
  const dockerfile = read(packageRoot, "Dockerfile");

  it("ships Debian's security-tracked Chromium, not a Playwright-bundled browser", () => {
    expect(dockerfile).not.toContain("mcr.microsoft.com/playwright");
    expect(dockerfile).not.toMatch(/playwright install/);
    expect(dockerfile).toContain("      chromium fonts-liberation fonts-noto-core");
    expect(dockerfile).toContain("ENV CHROMIUM_PATH=/usr/lib/chromium/chromium");
  });

  it("refuses to build below the CVE-2026-118306 floor, in step with the launcher", () => {
    // 156.0.8078.73 fixed CVE-2026-118306 (sandbox escape). Never lower it.
    expect(MIN_CHROMIUM_VERSION).toBe("156.0.8078.73");
    expect(dockerfile).toContain(`ARG CHROMIUM_MIN_VERSION=${MIN_CHROMIUM_VERSION}`);
    expect(dockerfile).toContain('dpkg --compare-versions "$installed" ge "$CHROMIUM_MIN_VERSION"');
  });

  it("runs as the unprivileged browser user, dropped to by the entrypoint", () => {
    expect(dockerfile).toContain("useradd --create-home --uid 10001 --user-group --shell /usr/sbin/nologin browser");
    expect(dockerfile).toContain("chown -R browser:browser /var/lib/hermes-browser");
    const entrypoint = read(packageRoot, "docker", "entrypoint.sh");
    const drop = entrypoint.indexOf('exec setpriv --reuid="$BROWSER_USER" --regid="$BROWSER_USER" --init-groups --inh-caps=-all');
    expect(drop).toBeGreaterThan(0);
    // Nothing starts before the drop: the display stack and Node come after it.
    for (const marker of ["supervise Xvfb", "node /app/cdp-proxy.mjs", "exec node dist/server.js"]) {
      expect(entrypoint.indexOf(marker)).toBeGreaterThan(drop);
    }
  });

  it("copies the compiled launch settings next to the CDP proxy that imports them", () => {
    const dist = dockerfile.indexOf("COPY --from=build /app/dist ./dist");
    const proxy = dockerfile.indexOf("COPY docker/cdp-proxy.mjs ./cdp-proxy.mjs");
    expect(dist).toBeGreaterThan(0);
    expect(proxy).toBeGreaterThan(0);
    expect(read(packageRoot, "docker", "cdp-proxy.mjs")).toContain('from "./dist/browser/chromium.js"');
  });
});
