"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

type WorkspaceModalSource = "agent-picker" | "surface" | "test-guide";
type SetWorkspaceModalActive = (
  source: WorkspaceModalSource,
  active: boolean,
) => void;

const WorkspaceModalLayerContext = createContext<SetWorkspaceModalActive>(() => undefined);

export function WorkspaceModalLayerProvider({
  children,
  onActiveChange,
}: {
  children: ReactNode;
  onActiveChange: (active: boolean) => void;
}) {
  const activeSourcesRef = useRef(new Set<WorkspaceModalSource>());

  const setActive = useCallback<SetWorkspaceModalActive>(
    (source, active) => {
      const activeSources = activeSourcesRef.current;
      if (active) {
        activeSources.add(source);
      } else {
        activeSources.delete(source);
      }
      onActiveChange(activeSources.size > 0);
    },
    [onActiveChange],
  );

  useEffect(
    () => () => {
      activeSourcesRef.current.clear();
      onActiveChange(false);
    },
    [onActiveChange],
  );

  return (
    <WorkspaceModalLayerContext.Provider value={setActive}>
      {children}
    </WorkspaceModalLayerContext.Provider>
  );
}

export function useWorkspaceModalLayer(
  source: WorkspaceModalSource,
  active: boolean,
) {
  const setActive = useContext(WorkspaceModalLayerContext);

  useEffect(() => {
    setActive(source, active);
    return () => setActive(source, false);
  }, [active, setActive, source]);
}
