function isExplicitlyEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** Server-render rollout decision. Disabling it restores the legacy route. */
export function isWorkspaceShellEnabled(
  value = process.env.HIVRA_WORKSPACE_SHELL_ENABLED,
): boolean {
  return isExplicitlyEnabled(value);
}

/** Independent client-visible decision for workspace navigation affordances. */
export function isWorkspaceShellNavigationEnabled(
  value = process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED,
): boolean {
  return isExplicitlyEnabled(value);
}
