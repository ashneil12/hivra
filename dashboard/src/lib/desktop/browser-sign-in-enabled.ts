export function desktopBrowserSignInEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HIVRA_DESKTOP_BROWSER_SIGNIN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
