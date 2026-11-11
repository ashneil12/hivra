/** Official x86 ISO naming changed when Omarchy added ARM images in 4.5. */
export function omarchyX86IsoFilename(release: string): string | null {
  const match = /^v4\.([0-9]{1,4})\.[0-9]{1,4}$/.exec(release);
  if (!match) return null;
  return `omarchy-${release.slice(1)}${Number(match[1]) >= 5 ? "-x86" : ""}.iso`;
}
