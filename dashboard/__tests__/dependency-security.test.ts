import lockfile from "../package-lock.json";

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }

  return 0;
}

describe("dependency security", () => {
  const packages = lockfile.packages as Record<string, { version?: string }>;
  const copiesOf = (name: string) => Object.entries(packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, info]) => ({ path, version: info.version ?? "0.0.0" }));

  // Dated release floor, not a substitute for a current advisory scan. Includes
  // the 2026-08-25 Next.js critical fixes, which were newer than repo alerts.
  it.each([
    ["next", "16.3.3"],
    ["pdfjs-dist", "6.2.108"],
    ["dompurify", "3.4.13"],
    ["undici", "7.29.0"],
    ["sharp", "0.35.4"],
    ["postcss", "8.5.23"],
    ["nanoid", "3.3.18"],
    ["@xmldom/xmldom", "0.8.15"],
    ["fflate", "0.4.9"],
    ["@humanfs/node", "0.16.8"],
  ])("keeps every %s copy at the reviewed security floor %s", (name, minimum) => {
    const copies = copiesOf(name);
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect({ path: copy.path, secure: compareSemver(copy.version, minimum) >= 0 })
        .toEqual({ path: copy.path, secure: true });
    }
  });

  it.each([
    ["js-yaml", { "3": "3.15.2", "4": "4.3.2" }],
    ["brace-expansion", { "1": "1.1.18", "5": "5.0.9" }],
  ] as const)("keeps every %s major line on its reviewed patch", (name, floors) => {
    const copies = copiesOf(name);
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.version).toMatch(/^\d+\.\d+\.\d+$/);
      const minimum = (floors as Record<string, string>)[copy.version.split(".")[0]];
      expect(minimum).toBeDefined();
      expect(compareSemver(copy.version, minimum)).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the Next framework, environment loader, third parties and lint plugin aligned", () => {
    const next = copiesOf("next")[0].version;
    for (const name of ["@next/env", "@next/third-parties", "eslint-config-next", "@next/eslint-plugin-next"]) {
      expect(copiesOf(name).map((copy) => copy.version)).toEqual([next]);
    }
  });

  it("does not install a PostCSS version vulnerable to GHSA-qx2v-qp2m-jg93", () => {
    const packages = lockfile.packages as Record<string, { version?: string }>;
    const postcssCopies = Object.entries(packages)
      .filter(([packagePath]) => packagePath === "node_modules/postcss" || packagePath.endsWith("/node_modules/postcss"))
      .map(([packagePath, packageInfo]) => ({
        packagePath,
        version: packageInfo.version ?? "0.0.0",
      }));

    expect(postcssCopies).not.toHaveLength(0);
    expect(postcssCopies).toEqual(
      postcssCopies.map((copy) => ({
        ...copy,
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      }))
    );
    expect(
      postcssCopies.filter((copy) => compareSemver(copy.version, "8.5.10") < 0)
    ).toEqual([]);
  });

  it("does not install an undici version vulnerable to the <7.28.0 TLS/SOCKS5/cache advisories", () => {
    // GHSA-vmh5-mc38-953g (TLS bypass), GHSA-hm92-r4w5-c3mj (SOCKS5 pool reuse),
    // GHSA-vxpw-j846-p89q (WS DoS), GHSA-pr7r-676h-xcf6 (shared-cache disclosure),
    // GHSA-p88m-4jfj-68fv (Set-Cookie header injection) — all fixed in undici 7.28.0.
    const packages = lockfile.packages as Record<string, { version?: string }>;
    const undiciCopies = Object.entries(packages)
      .filter(([packagePath]) => packagePath === "node_modules/undici" || packagePath.endsWith("/node_modules/undici"))
      .map(([packagePath, packageInfo]) => ({
        packagePath,
        version: packageInfo.version ?? "0.0.0",
      }));

    expect(undiciCopies).not.toHaveLength(0);
    expect(undiciCopies).toEqual(
      undiciCopies.map((copy) => ({
        ...copy,
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      }))
    );
    expect(
      undiciCopies.filter((copy) => compareSemver(copy.version, "7.28.0") < 0)
    ).toEqual([]);
  });
});
