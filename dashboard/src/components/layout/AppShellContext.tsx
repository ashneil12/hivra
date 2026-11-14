"use client";

import { createContext, useContext } from "react";

/**
 * What the dashboard layout offers a page that draws its own navigation.
 *
 * The agent view replaces the global rail with its own sidebar, but the
 * switcher dialog (and the ⌘K handler that opens it) still belongs to the
 * layout. A page reaches it here instead of mounting a second dialog.
 */
export interface AppShell {
  /** Opens the layout's agent and computer switcher. */
  openSwitcher: () => void;
  /** The signed-in account's display name, for a page's own account row. */
  userName: string;
}

export const AppShellContext = createContext<AppShell | null>(null);

/** The layout's shell, or null where a page renders outside the dashboard layout. */
export function useAppShell(): AppShell | null {
  return useContext(AppShellContext);
}
