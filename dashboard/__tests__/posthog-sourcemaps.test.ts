import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("PostHog source map configuration", () => {
  it("keeps browser source maps enabled and uploads them after production builds", () => {
    const root = process.cwd();
    const nextConfig = readFileSync(join(root, "next.config.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const uploadScriptPath = join(root, "scripts/upload-posthog-sourcemaps.cjs");
    const uploadScript = existsSync(uploadScriptPath) ? readFileSync(uploadScriptPath, "utf8") : "";

    expect(nextConfig).toContain("productionBrowserSourceMaps: true");
    expect(packageJson.scripts?.postbuild).toBe("node scripts/upload-posthog-sourcemaps.cjs");
    expect(uploadScript).toContain("POSTHOG_CLI_API_KEY");
    expect(uploadScript).toContain("POSTHOG_CLI_PROJECT_ID");
    expect(uploadScript).toContain("@posthog/cli@0.7.11");
    expect(uploadScript).toContain("sourcemap");
    expect(uploadScript).toContain("process");
    expect(uploadScript).toContain("--release-version");
    expect(uploadScript.indexOf("--host")).toBeLessThan(uploadScript.indexOf("\"sourcemap\""));
  });
});
