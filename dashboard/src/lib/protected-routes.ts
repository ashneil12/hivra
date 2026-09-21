const PROTECTED_PATH_PATTERNS = [
  /^\/dashboard(?:\/.*)?$/,
  /^\/api\/instances(?:\/.*)?$/,
  /^\/api\/conversations(?:\/.*)?$/,
  /^\/api\/upload-migration$/,
  // Workspace Cloud pages (connect + the simple dashboard) — browser
  // navigation should redirect to sign-in. The lane's API routes enforce
  // their own JSON 401s, and the M2M /api/workspace-cloud/handoff/exchange
  // must stay unauthenticated, so neither is force-protected here (they're
  // under /api/, not /workspace-cloud/).
  /^\/workspace-cloud(?:\/.*)?$/,
];

export const PROTECTED_ROUTE_MATCHERS = [
  "/dashboard(.*)",
  "/api/instances(.*)",
  "/api/conversations(.*)",
  "/api/upload-migration",
  "/workspace-cloud(.*)",
];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}
