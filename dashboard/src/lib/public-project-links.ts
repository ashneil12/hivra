import { desktopBrowserSignInEnabled } from "./desktop/browser-sign-in-enabled";

/**
 * Public website destinations, verified independently of the private Git remote.
 *
 * Public source verified on 2026-09-21 at github.com/ashneil12/hivra.
 * Desktop download links require desktop browser sign-in on this deployment.
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

export type DesktopPlatform = "macos" | "windows" | "linux";

export type DesktopRelease =
  | Readonly<{ status: "pending"; href: null }>
  | Readonly<{
      status: "published";
      href: `https://${string}`;
      /** Public release label, including architecture when relevant. */
      label: string;
    }>;

export type DesktopDownloads = Readonly<Record<DesktopPlatform, DesktopRelease>>;

export function getDesktopDownloads(env: Record<string, string | undefined> = process.env): DesktopDownloads {
  return {
    macos: desktopBrowserSignInEnabled(env) && env.HIVRA_AUTH_MODE?.trim().toLowerCase() !== "local"
      ? {
          status: "published",
          href: "https://github.com/ashneil12/hivra/releases/download/mac-v0.3.0/Hivra.dmg",
          label: "For Apple silicon and Intel Macs, macOS 14 or newer.",
        }
      : { status: "pending", href: null },
    // Windows and Linux builds exist, but unsigned CI artifacts are not public
    // downloads. Keep these pending until their release destinations exist.
    windows: { status: "pending", href: null },
    linux: { status: "pending", href: null },
  };
}

export const PUBLIC_PROJECT_LINKS: Readonly<{
  repository: PublicRepository;
  browser: string;
  /** Official X account, the same handle as twitter:site in app/layout.tsx. */
  x: `https://x.com/${string}`;
}> = {
  repository: { status: "published", href: "https://github.com/ashneil12/hivra", stars: null },
  browser: "/dashboard",
  x: "https://x.com/HivraOS",
};

/** Official profiles for Organization structured data (schema.org sameAs). */
export function officialProfileLinks(): string[] {
  const { x, repository } = PUBLIC_PROJECT_LINKS;
  return repository.status === "published" ? [x, repository.href] : [x];
}
