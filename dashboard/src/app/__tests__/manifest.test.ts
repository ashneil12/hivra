import { readFileSync } from "node:fs";
import { join } from "node:path";

import manifest from "../manifest";

// Width and height from a PNG's IHDR chunk.
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("app manifest", () => {
  it("launches the original agent dashboard without credential state", () => {
    const result = manifest();

    expect(result.name).toBe("Hivra");
    expect(result.short_name).toBe("Hivra");
    expect(result.start_url).toBe("/dashboard");
    expect(result.scope).toBe("/dashboard/");
    expect(result.display).toBe("standalone");
    expect(result).not.toHaveProperty("orientation");
    expect(result.background_color).toBe("#0d0d0d");
    expect(result.theme_color).toBe("#0d0d0d");
    expect(result.start_url).not.toMatch(/[?#]|token|secret|key/i);
    // Agents, Computers and Launch, never the Hermes-only chat or the
    // workspace preview that only redirected Home.
    expect(result.shortcuts?.map(({ name, url }) => [name, url])).toEqual([
      ["Agents", "/dashboard/agents"],
      ["Computers", "/dashboard/computers"],
      ["Launch", "/dashboard/launch"],
      ["Wallet", "/dashboard/wallet"],
      ["Billing", "/dashboard/billing"],
    ]);
    expect(result.shortcuts?.every(({ url }) => url.startsWith("/dashboard"))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/bearer|api[_-]?token|secret|api[_-]?key/i);
    expect(result.icons).toEqual([
      { src: "/brand/hivra-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/hivra-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/hivra-icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/hivra-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("points every icon at a committed export of the approved logo", () => {
    for (const icon of manifest().icons ?? []) {
      const file = join(process.cwd(), "public", icon.src);
      const [width, height] = pngSize(readFileSync(file));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});
