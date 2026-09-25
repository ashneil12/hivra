"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isHivraEnabled } from "@/lib/hivra/hivra-flag";
import {
  resourceInventory,
  type InventorySourceState,
} from "@/lib/workspace/resource-inventory";
import { parseDashboardResources, type DashboardResource, type DashboardResourceSource } from "./dashboard-resources";

type SourceView = { resources: DashboardResource[]; loading: boolean; error: string | null };
const errors = { hermes: "Hermes agents could not be refreshed.", hivra: "Other agents and computers could not be refreshed." };
const LOADING: SourceView = { resources: [], loading: true, error: null };
const OFF: SourceView = { resources: [], loading: false, error: null };

/** The resource a detail route names, so arriving on one the list lacks re-reads it. */
function routeResource(routeKey: string | null | undefined): { source: DashboardResourceSource; id: string } | null {
  const match = routeKey?.match(/^\/dashboard\/(agent|instances)\/([^/?#]+)/);
  if (!match) return null;
  try {
    return { source: match[1] === "agent" ? "hivra" : "hermes", id: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function listsResource(state: InventorySourceState, source: DashboardResourceSource, id: string): boolean {
  if (!state.hasBody) return false;
  try {
    return parseDashboardResources(state.body, source).some((resource) => resource.id === id);
  } catch {
    return false;
  }
}

function sourceView(state: InventorySourceState, source: DashboardResourceSource): SourceView {
  let resources: DashboardResource[] = [];
  let unreadable = false;
  if (state.hasBody) {
    try {
      resources = parseDashboardResources(state.body, source);
    } catch {
      unreadable = true;
    }
  }
  return {
    resources,
    loading: state.pending || state.settledAt === 0,
    error: state.failed || unreadable ? errors[source] : null,
  };
}

/**
 * The agents and computers the shell's switchers list, from the shared
 * inventory. Moving between pages reuses a fresh read; opening a resource the
 * held list does not have (one just launched) reads its list again.
 */
export function useDashboardResources(owner: string, routeKey?: string | null) {
  const snapshot = useSyncExternalStore(
    resourceInventory.subscribe,
    resourceInventory.getSnapshot,
    resourceInventory.getServerSnapshot,
  );
  // Whether Hivra is on is only known in the browser (hostname), after hydration.
  const [hivraOn, setHivraOn] = useState<boolean | null>(null);

  useEffect(() => {
    resourceInventory.setOwner(owner);
    const enabled = isHivraEnabled();
    // A deliberately disabled source is not a failed network read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHivraOn(enabled);
    const named = routeResource(routeKey);
    // Each source resolves independently: one unavailable service cannot hide the other.
    for (const source of enabled ? (["hermes", "hivra"] as const) : (["hermes"] as const)) {
      const unknownHere = named?.source === source
        && !listsResource(resourceInventory.getSnapshot()[source], source, named.id);
      void resourceInventory.load(source, { force: unknownHere });
    }
  }, [owner, routeKey]);

  const refresh = useCallback(() => {
    void resourceInventory.load("hermes", { force: true });
    if (isHivraEnabled()) void resourceInventory.load("hivra", { force: true });
  }, []);

  // Never show the previous account's snapshot while the next effect is pending.
  const mine = snapshot.owner === owner;
  const hermes = useMemo(() => mine ? sourceView(snapshot.hermes, "hermes") : LOADING, [mine, snapshot.hermes]);
  const hivra = useMemo(
    () => hivraOn === false ? OFF : mine ? sourceView(snapshot.hivra, "hivra") : LOADING,
    [hivraOn, mine, snapshot.hivra],
  );
  const resources = useMemo(() => [...hermes.resources, ...hivra.resources], [hermes.resources, hivra.resources]);
  return {
    resources,
    loading: hermes.loading || hivra.loading,
    errors: { hermes: hermes.error, hivra: hivra.error },
    refresh,
  };
}
