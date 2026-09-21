"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHivraEnabled } from "@/lib/hivra/hivra-flag";
import { parseDashboardResources, type DashboardResource, type DashboardResourceSource } from "./dashboard-resources";

type SourceState = { resources: DashboardResource[]; loading: boolean; error: string | null };
type Snapshot = { owner: string; hermes: SourceState; hivra: SourceState };
const emptySource = (): SourceState => ({ resources: [], loading: true, error: null });
const emptySnapshot = (owner: string): Snapshot => ({ owner, hermes: emptySource(), hivra: emptySource() });
const paths = { hermes: "/api/instances?summary=true", hivra: "/api/hivra/agents" };
const errors = { hermes: "Hermes agents could not be refreshed.", hivra: "Other agents and computers could not be refreshed." };

export function useDashboardResources(owner: string, routeKey?: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshot(owner));
  const controllers = useRef<Partial<Record<DashboardResourceSource, AbortController>>>({});
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const requests = controllers.current;
    // Each source resolves independently: one unavailable service cannot hide the other.
    for (const source of ["hermes", "hivra"] as const) {
      if (source === "hivra" && !isHivraEnabled()) {
        // A deliberately disabled source is not a failed network read.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSnapshot((current) => ({
          ...(current.owner === owner ? current : emptySnapshot(owner)),
          hivra: { resources: [], loading: false, error: null },
        }));
        continue;
      }
      const controller = new AbortController();
      requests[source] = controller;
      // Start a new external-source read while retaining explicitly last-known metadata.
      setSnapshot((current) => {
        const next = current.owner === owner ? current : emptySnapshot(owner);
        return { ...next, [source]: { ...next[source], loading: true } };
      });
      void fetch(paths[source], { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Resource source unavailable");
          return parseDashboardResources(await response.json(), source);
        })
        .then((resources) => {
          if (controller.signal.aborted) return;
          setSnapshot((current) => current.owner !== owner ? current : {
            ...current, [source]: { resources, loading: false, error: null },
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setSnapshot((current) => current.owner !== owner ? current : {
            ...current, [source]: { ...current[source], loading: false, error: errors[source] },
          });
        });
    }
    return () => { requests.hermes?.abort(); requests.hivra?.abort(); };
  }, [owner, revision, routeKey]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // Never show the previous account's snapshot while the next effect is pending.
  const current = useMemo(() => snapshot.owner === owner ? snapshot : emptySnapshot(owner), [snapshot, owner]);
  const resources = useMemo(() => [...current.hermes.resources, ...current.hivra.resources], [current.hermes.resources, current.hivra.resources]);
  return {
    resources,
    loading: current.hermes.loading || current.hivra.loading,
    errors: { hermes: current.hermes.error, hivra: current.hivra.error },
    refresh,
  };
}
