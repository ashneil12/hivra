import { omarchyX86IsoFilename } from "../src/lib/omarchy-iso";

// Resolve metadata only. The installer bytes are downloaded later and must match
// this release's official checksum; no code from a floating branch is executed.
export type OmarchyInstallerRelease = {
  release: string;
  releaseCommit: string;
  isoUrl: string;
  isoSha256: string;
  isoFilename: string;
};

export const VALIDATED_OMARCHY_INSTALLER: OmarchyInstallerRelease = {
  release: "v4.0.6",
  releaseCommit: "237f1b4071a0bff2296c6d740ba2b9fd695ebfa0",
  isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso",
  isoSha256: "b542db5fecc37395d9af6654a8146ebed225f275ae4d5a6fcf432e40afe7bb88",
  isoFilename: "omarchy-4.0.6.iso",
};

const TAG = /^v4\.[0-9]{1,4}\.[0-9]{1,4}$/;
const SHA = /^[a-f0-9]{40}$/;

export function assertOmarchyInstallerRelease(value: OmarchyInstallerRelease): void {
  if (!TAG.test(value.release) || !SHA.test(value.releaseCommit)
    || !/^[a-f0-9]{64}$/.test(value.isoSha256)
    || value.isoFilename !== omarchyX86IsoFilename(value.release)
    || value.isoUrl !== `https://iso.omarchy.org/${value.isoFilename}`) {
    throw new Error("Omarchy installer release metadata is invalid or uses an unvalidated major.");
  }
}

async function metadata(url: string, fetcher: typeof fetch, overallSignal?: AbortSignal): Promise<string> {
  const response = await fetcher(url, {
    signal: overallSignal ? AbortSignal.any([overallSignal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Hivra-Omarchy-installer" },
  });
  if (!response.ok) throw new Error(`Official Omarchy metadata request failed (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Official Omarchy metadata response is empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 131_072) throw new Error("Official Omarchy metadata response is too large.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolve for an operator build or a new claim; existing owner opens do not call upstream. */
export async function resolveLatestOmarchyInstaller(fetcher: typeof fetch = fetch, overallSignal?: AbortSignal): Promise<OmarchyInstallerRelease> {
  const repository = "https://api.github.com/repos/omacom/omarchy";
  const release = JSON.parse(await metadata(`${repository}/releases/latest`, fetcher, overallSignal)) as Record<string, unknown>;
  const tag = release.tag_name;
  if (release.draft !== false || release.prerelease !== false || typeof tag !== "string" || !TAG.test(tag)) {
    throw new Error("Latest official Omarchy release is not a supported stable v4 release.");
  }
  let object = (JSON.parse(await metadata(`${repository}/git/ref/tags/${tag}`, fetcher, overallSignal)) as {
    ref?: string; object?: { type?: string; sha?: string };
  });
  if (object.ref !== `refs/tags/${tag}`) throw new Error("Official Omarchy tag identity does not match.");
  let target = object.object;
  // GitHub releases can use an annotated tag; resolve to an immutable commit.
  for (let depth = 0; target?.type === "tag" && depth < 3; depth += 1) {
    if (!SHA.test(target.sha ?? "")) throw new Error("Official Omarchy tag object is invalid.");
    object = JSON.parse(await metadata(`${repository}/git/tags/${target.sha}`, fetcher, overallSignal));
    target = object.object;
  }
  if (target?.type !== "commit" || !SHA.test(target.sha ?? "")) {
    throw new Error("Official Omarchy tag did not resolve to one immutable commit.");
  }
  const isoFilename = omarchyX86IsoFilename(tag);
  if (!isoFilename) throw new Error("Official Omarchy x86 artifact is unsupported.");
  const checksum = await metadata(`https://iso.omarchy.org/${isoFilename}.sha256`, fetcher, overallSignal);
  const match = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/.exec(checksum);
  if (!match || match[2] !== isoFilename) throw new Error("Official Omarchy ISO checksum names a different artifact.");
  const resolved = { release: tag, releaseCommit: target.sha!, isoFilename,
    isoUrl: `https://iso.omarchy.org/${isoFilename}`, isoSha256: match[1] };
  assertOmarchyInstallerRelease(resolved);
  return resolved;
}
