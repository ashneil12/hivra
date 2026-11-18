/**
 * Public website destinations, verified independently of the private Git remote.
 *
 * Public source verified on 2026-09-21 at github.com/ashneil12/hivra.
 * Desktop installers remain unpublished. Source availability does not imply
 * that a signed installer or separately distributed runtime image is available.
 *
 * Replace a pending entry only after its public destination is verified. A stars
 * snapshot must come from that repository's public GitHub API response. Unknown
 * is null, never a fabricated zero. Rendering does not depend on an API request.
 */
export type GitHubStars = Readonly<{ count: number; checkedAt: string }>;

export type PublicRepository =
  | Readonly<{ status: "pending"; href: null; stars: null }>
  | Readonly<{
      status: "published";
      href: `https://github.com/${string}/${string}`;
      stars: GitHubStars | null;
    }>;

// Only a macOS app is in development. There is no Windows desktop app.
export type DesktopPlatform = "macos";

export type DesktopRelease =
  | Readonly<{ status: "pending"; href: null }>
  | Readonly<{
      status: "published";
      href: `https://${string}`;
      /** Public release label, including architecture when relevant. */
      label: string;
    }>;

export type DesktopDownloads = Readonly<Record<DesktopPlatform, DesktopRelease>>;

/**
 * The Mac download stays "coming soon" until NEXT_PUBLIC_HIVRA_MAC_DOWNLOAD_URL
 * names the signed, notarised installer (an https address, normally the
 * GitHub release asset). Anything else keeps the button disabled.
 */
export function macDownloadFromEnv(value: string | undefined): DesktopRelease {
  const href = value?.trim();
  if (!href || !/^https:\/\/[^\s]+$/.test(href)) return { status: "pending", href: null };
  return {
    status: "published",
    href: href as `https://${string}`,
    label: "For Apple silicon and Intel Macs, macOS 14 or newer.",
  };
}

export const PUBLIC_PROJECT_LINKS: Readonly<{
  repository: PublicRepository;
  desktop: DesktopDownloads;
  browser: string;
  /** Official X account, the same handle as twitter:site in app/layout.tsx. */
  x: `https://x.com/${string}`;
}> = {
  repository: { status: "published", href: "https://github.com/ashneil12/hivra", stars: null },
  desktop: {
    macos: macDownloadFromEnv(process.env.NEXT_PUBLIC_HIVRA_MAC_DOWNLOAD_URL),
  },
  browser: "/dashboard",
  x: "https://x.com/HivraOS",
};

/** Official profiles for Organization structured data (schema.org sameAs). */
export function officialProfileLinks(): string[] {
  const { x, repository } = PUBLIC_PROJECT_LINKS;
  return repository.status === "published" ? [x, repository.href] : [x];
}
