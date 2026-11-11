// The window's own title (the Mac's Window menu, Mission Control, the Dock): what Ash is looking at, then the app.

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * `activeName` is the workspace tab's name and `cwd` its folder. A hub view shown over the workspace (`viewTitle`, e.g.
 * New project) names the window instead: the workspace under it is hidden, so its tab or folder never shows up in the
 * title while that view is open.
 */
export function systemWindowTitle(activeName: string, cwd: string, app: string, viewTitle?: string): string {
  if (viewTitle) return `${viewTitle} — ${app}`;
  const project = cwd ? lastSegment(cwd) : "";
  if (activeName && project && activeName !== project) return `${activeName} — ${project} — ${app}`;
  if (project) return `${project} — ${app}`;
  return app;
}
