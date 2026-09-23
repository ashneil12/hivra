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

export const PUBLIC_PROJECT_LINKS: Readonly<{
  repository: PublicRepository;
  desktop: DesktopDownloads;
  browser: string;
}> = {
  repository: { status: "published", href: "https://github.com/ashneil12/hivra", stars: null },
  desktop: {
    macos: { status: "pending", href: null },
  },
  browser: "/dashboard",
};
