/**
 * Public website destinations, verified independently of the private Git remote.
 *
 * Last checked 2026-09-09: no public Hivra platform repository or public macOS /
 * Windows installer was found. The Mac 0.2.0 alpha is a local build, not a public
 * download. See docs/release/PUBLIC-REPOSITORY-DECISION.md and
 * docs/release/2026-09-09-mac-native-workspace.md.
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

export type DesktopPlatform = "macos" | "windows";

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
  repository: { status: "pending", href: null, stars: null },
  desktop: {
    macos: { status: "pending", href: null },
    windows: { status: "pending", href: null },
  },
  browser: "/dashboard",
};
