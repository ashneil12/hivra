import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");

describe("browser-sidecar image build contract", () => {
  it("requires browser installation and real integration tests before publishing", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "browser-sidecar-publish.yml"), "utf8");
    const job = parse(workflow).jobs["verify-and-publish"];
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job["timeout-minutes"]).toBe(30);
    const steps = job.steps as Array<Record<string, unknown>>;
    const installIndex = steps.findIndex((step) => step.name === "Install Playwright Chromium");
    const integrationIndex = steps.findIndex((step) => step.name === "Integration test (persist-session)");
    const buildIndex = steps.findIndex((step) => step.name === "Build & push image");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(integrationIndex).toBeGreaterThan(installIndex);
    expect(buildIndex).toBeGreaterThan(integrationIndex);
    expect(steps[installIndex].run).toBe("npx playwright install chromium");
    expect(steps[integrationIndex]).toMatchObject({
      run: "npm run test:integration",
      env: { RUN_INTEGRATION: "1" },
    });
    for (const index of [installIndex, integrationIndex, buildIndex]) {
      expect(steps[index]["continue-on-error"]).toBeUndefined();
      // Default success() semantics are required, not always() after a failure.
      expect([undefined, "success()"]).toContain(steps[index].if);
    }
  });

  it("uses the committed lockfile for Docker and CI dependency installs", () => {
    const dockerfile = readFileSync(join(packageRoot, "Dockerfile"), "utf8");
    const publishWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "browser-sidecar-publish.yml"),
      "utf8"
    );

    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev --no-audit --no-fund");
    expect(dockerfile).toContain("npm ci --no-audit --no-fund");
    expect(dockerfile).not.toContain("npm install --omit=dev");
    expect(dockerfile).not.toContain("RUN npm install --no-audit --no-fund");

    expect(publishWorkflow).toContain("run: npm ci --no-audit --no-fund");
    expect(publishWorkflow).not.toContain("run: npm install --no-audit --no-fund");
  });

  it("pins every external base image to an immutable multi-platform digest", () => {
    const dockerfile = readFileSync(join(packageRoot, "Dockerfile"), "utf8");
    const fromLines = dockerfile.split(/\r?\n/).filter((line) => line.startsWith("FROM "));

    expect(fromLines).toEqual([
      "FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps",
      "FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build",
      "FROM mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3cb99aa7803adbc14d9027ec1785fc6e433b97e134e0f8fe61683b6b53 AS runtime",
    ]);
  });

  it("does not require the private sidecar image to be pulled anonymously", () => {
    const publishWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "browser-sidecar-publish.yml"),
      "utf8"
    );

    expect(publishWorkflow).not.toContain("Make package public");
    expect(publishWorkflow).not.toContain("Verify anonymous GHCR pull");
    expect(publishWorkflow).not.toContain("docker logout ghcr.io");
    expect(publishWorkflow).not.toContain("must be public before VMs can pull it");
  });

  it("publishes the canary and prod sidecar packages from their matching repos", () => {
    const publishWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "browser-sidecar-publish.yml"),
      "utf8"
    );

    // The repo name reaches the shell via an env var, never via `${{ }}`
    // expansion inside `run:` (zizmor template-injection hardening). Assert the
    // hardened indirection so a regression back to inline `${{ }}` is caught.
    expect(publishWorkflow).toContain('_REPO_NAME: ${{ github.event.repository.name }}');
    expect(publishWorkflow).toContain('repo_name="$_REPO_NAME"');
    expect(publishWorkflow).not.toContain('repo_name="${{ github.event.repository.name }}"');
    expect(publishWorkflow).toContain('if [[ "$repo_name" == *-canary ]]; then');
    expect(publishWorkflow).toContain('package_name="hermes-browser-sidecar-canary"');
    expect(publishWorkflow).toContain('package_name="hermes-browser-sidecar"');
    expect(publishWorkflow).toContain('base="ghcr.io/${repo_lc}/${package_name}"');
    expect(publishWorkflow).not.toContain('base="ghcr.io/${repo_lc}/hermes-browser-sidecar-canary"');
  });
});
