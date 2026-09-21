import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const caddyfilePath = join(here, "..", "caddy", "Caddyfile");

describe("browser-sidecar Caddyfile", () => {
  it("allows dashboard-hosted noVNC viewers to import static noVNC modules", () => {
    const caddyfile = readFileSync(caddyfilePath, "utf8");
    const staticAssetsBlock = caddyfile.match(
      /handle_path \/browser-sidecar\/novnc\/\* \{[\s\S]*?\n\t\}/
    )?.[0] || "";

    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Origin "*"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Methods "GET, OPTIONS"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Headers "Content-Type"');
  });
});
