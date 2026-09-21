"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  useSurfaceActionStore,
  type SurfaceAction,
  type SurfaceActionIcon,
} from "./SurfaceActionContext";
import styles from "./ResourceSurfaceNavigation.module.css";

/**
 * The actions the active surface has lifted into the bar.
 *
 * Renders nothing at all when no store is present, no surface is active, or the
 * active surface published nothing — so a tab whose surface has no everyday
 * action is identical to before this existed.
 */

const ICONS: Record<SurfaceActionIcon, typeof ExternalLink> = {
  "external-link": ExternalLink,
};

const EMPTY_ACTIONS: readonly SurfaceAction[] = Object.freeze([]);

export function SurfaceActions({ surfaceId }: { surfaceId?: string }) {
  const store = useSurfaceActionStore();

  // `useSyncExternalStore` compares snapshots by identity and re-subscribes when
  // `subscribe` changes, so both callbacks must be stable for a given slot.
  const subscribe = useCallback(
    (listener: () => void) =>
      store && surfaceId ? store.subscribe(surfaceId, listener) : () => {},
    [store, surfaceId],
  );
  const getSnapshot = useCallback(
    () => (store && surfaceId ? store.getSnapshot(surfaceId).actions : EMPTY_ACTIONS),
    [store, surfaceId],
  );
  const getServerSnapshot = useCallback(() => EMPTY_ACTIONS, []);

  const actions = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const rendered = useMemo(
    () =>
      actions.map((action) => {
        const Icon = ICONS[action.icon];
        return (
          <button
            key={action.id}
            type="button"
            onClick={action.onSelect}
            disabled={action.disabled}
            aria-label={action.label}
            title={action.label}
            className={styles.actionIcon}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      }),
    [actions],
  );

  if (!store || !surfaceId || actions.length === 0) return null;

  return <div className={styles.actions}>{rendered}</div>;
}
