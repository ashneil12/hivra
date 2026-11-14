import { OmarchyRefreshReleaseSchema } from "../prepared-omarchy-refresh-contract";

const base = { release: "v4.5.0", releaseCommit: "a".repeat(40), isoSha256: "b".repeat(64) };
it.each([
  ["v4.0.6", "omarchy-4.0.6.iso", true],
  ["v4.4.0", "omarchy-4.4.0.iso", true],
  ["v4.5.0", "omarchy-4.5.0-x86.iso", true],
  ["v4.10.0", "omarchy-4.10.0-x86.iso", true],
  ["v4.5.0", "omarchy-4.5.0.iso", false],
  ["v4.5.0", "omarchy-4.5.0-arm.iso", false],
  ["v4.5.0", "omarchy-4.5.1-x86.iso", false],
  ["v5.0.0", "omarchy-5.0.0-x86.iso", false],
  ["v4.bad.0", "omarchy-4.bad.0-x86.iso", false],
])("validates release %s with artifact %s", (release, isoFilename, expected) => {
  expect(OmarchyRefreshReleaseSchema.safeParse({ ...base, release, isoFilename, isoUrl: `https://iso.omarchy.org/${isoFilename}` }).success).toBe(expected);
});
it("refuses an official filename on an unrelated origin", () => {
  expect(OmarchyRefreshReleaseSchema.safeParse({ ...base, isoFilename: "omarchy-4.5.0-x86.iso", isoUrl: "https://untrusted.example/omarchy-4.5.0-x86.iso" }).success).toBe(false);
});
