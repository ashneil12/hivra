import { DIGEST_PATTERN } from "./policy";

/**
 * Resolve an image tag to its immutable digest from GHCR, so ops register a
 * release by tag and never paste a digest. Only ghcr.io is supported: the
 * agent images are public there and boxes pull them without credentials.
 */

const GHCR_HOST = "ghcr.io";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const REQUEST_TIMEOUT_MS = 10_000;

const REPO_PATH_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export class ReleaseRegistryError extends Error {}

export interface ParsedImageRepo {
  host: string;
  path: string;
}

export function parseImageRepo(imageRepo: string): ParsedImageRepo {
  const trimmed = imageRepo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) throw new ReleaseRegistryError("Image repository must include a registry host.");
  const host = trimmed.slice(0, slash).toLowerCase();
  const path = trimmed.slice(slash + 1);
  if (!REPO_PATH_PATTERN.test(path)) {
    throw new ReleaseRegistryError("Image repository path is not valid.");
  }
  return { host, path };
}

export async function resolveGhcrTag(
  imageRepo: string,
  tag: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const { host, path } = parseImageRepo(imageRepo);
  if (host !== GHCR_HOST) {
    throw new ReleaseRegistryError(`Only ${GHCR_HOST} images can be resolved by tag.`);
  }
  if (!TAG_PATTERN.test(tag)) throw new ReleaseRegistryError("Image tag is not valid.");

  const tokenRes = await fetchImpl(
    `https://${GHCR_HOST}/token?service=${GHCR_HOST}&scope=${encodeURIComponent(`repository:${path}:pull`)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!tokenRes.ok) {
    throw new ReleaseRegistryError(`GHCR token request failed (${tokenRes.status}).`);
  }
  const token = ((await tokenRes.json()) as { token?: string }).token;
  if (!token) throw new ReleaseRegistryError("GHCR returned no pull token.");

  const manifestRes = await fetchImpl(`https://${GHCR_HOST}/v2/${path}/manifests/${tag}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (manifestRes.status === 404) {
    throw new ReleaseRegistryError(`Tag ${tag} was not found in ${imageRepo}.`);
  }
  if (!manifestRes.ok) {
    throw new ReleaseRegistryError(`GHCR manifest request failed (${manifestRes.status}).`);
  }
  const digest = manifestRes.headers.get("docker-content-digest")?.trim() ?? "";
  if (!DIGEST_PATTERN.test(digest)) {
    throw new ReleaseRegistryError("GHCR returned no valid content digest.");
  }

  return digest;
}
