"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Lifts a surface's everyday actions into the surface bar above it.
 *
 * The bar and the surface content are SIBLINGS — the bar is rendered by the
 * page, the surface is rendered further down inside `.workPane` — so a surface
 * cannot hand it a prop. Several surfaces also stay mounted while hidden (the
 * remote desktop deliberately keeps its expensive session across tab switches),
 * which means "who publishes" cannot be left to render order: a hidden desktop
 * would otherwise publish a control onto whatever surface you are actually
 * looking at.
 *
 * So the flow is a small registry with two independent guards:
 *
 *   1. DECLARE-TIME — a surface publishes only when a store exists AND it is
 *      the active surface. Every mounted surface already receives a real
 *      per-tab `active` prop from the page, so this needs no new plumbing.
 *   2. READ-TIME — the bar reads only the slot for the active tab, so even a
 *      leaked slot could not render.
 *
 * WHAT MAY BE PUBLISHED HERE IS DELIBERATELY NARROW. An action qualifies only
 * when it is (a) an action, not a diagnosis; (b) fully described by its label
 * and disabled state; and (c) not coupled to where it is rendered. That last
 * one is not a style preference — the desktops fullscreen their own root
 * element and keep their exit control inside it, so lifting that button would
 * strand the user with no way out when the guest swallows Escape. Recovery
 * actions stay with their failure text for the same reason: a failure must not
 * look like a normal toolbar. See the exclusions on `SurfaceActionIcon`.
 *
 * AND A SURFACE WITHOUT A STORE KEEPS ITS OWN CONTROL. `useSurfaceAction`
 * reports whether it published, and the surface renders its control only when
 * it did not. That keeps a standalone render (a component test, a surface
 * mounted outside this page) behaving exactly as it did before.
 */

/**
 * The closed set of glyphs a lifted action may use. The bar maps these to
 * icons, so a surface never imports a component into the bar's vocabulary —
 * and an action that needs a glyph not in this set is a signal that it
 * probably should not have been lifted.
 */
export type SurfaceActionIcon = "external-link";

export interface SurfaceAction {
  /** Stable within a surface, e.g. "open-in-new-tab". */
  id: string;
  /** Accessible name, and the visible text wherever the action is listed. */
  label: string;
  icon: SurfaceActionIcon;
  /** The surface's own closure. The behaviour never moves, only the button. */
  onSelect: () => void;
  disabled?: boolean;
}

interface Slot {
  version: number;
  actions: SurfaceAction[];
}

export interface SurfaceActionSnapshot {
  version: number;
  actions: SurfaceAction[];
}

export interface SurfaceActionStore {
  subscribe: (surfaceId: string, listener: () => void) => () => void;
  getSnapshot: (surfaceId: string) => SurfaceActionSnapshot;
  getServerSnapshot: () => SurfaceActionSnapshot;
  publish: (surfaceId: string, actions: SurfaceAction[]) => void;
  release: (surfaceId: string) => void;
}

/**
 * A frozen empty snapshot, shared by every empty read.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning a fresh
 * `[]` on each read would re-render forever. Server render and the first client
 * render both read this same constant, which is what makes hydration agree.
 */
const EMPTY: SurfaceActionSnapshot = Object.freeze({ version: 0, actions: [] });

export function createSurfaceActionStore(): SurfaceActionStore {
  const slots = new Map<string, Slot>();
  const listeners = new Map<string, Set<() => void>>();
  // Snapshots are cached per slot so repeated reads inside one render return the
  // same object. The version only moves when a slot is actually republished.
  const snapshots = new Map<string, SurfaceActionSnapshot>();

  const notify = (surfaceId: string) => {
    const registered = listeners.get(surfaceId);
    if (!registered) return;
    for (const listener of registered) listener();
  };

  return {
    subscribe(surfaceId, listener) {
      let registered = listeners.get(surfaceId);
      if (!registered) {
        registered = new Set();
        listeners.set(surfaceId, registered);
      }
      registered.add(listener);
      return () => {
        registered.delete(listener);
        if (registered.size === 0) listeners.delete(surfaceId);
      };
    },
    getSnapshot(surfaceId) {
      const slot = slots.get(surfaceId);
      if (!slot) return EMPTY;
      const cached = snapshots.get(surfaceId);
      if (cached && cached.version === slot.version) return cached;
      const next: SurfaceActionSnapshot = { version: slot.version, actions: slot.actions };
      snapshots.set(surfaceId, next);
      return next;
    },
    getServerSnapshot() {
      return EMPTY;
    },
    publish(surfaceId, actions) {
      const previous = slots.get(surfaceId);
      const version = (previous?.version ?? 0) + 1;
      slots.set(surfaceId, { version, actions });
      snapshots.delete(surfaceId);
      notify(surfaceId);
    },
    release(surfaceId) {
      if (!slots.has(surfaceId)) return;
      slots.delete(surfaceId);
      snapshots.delete(surfaceId);
      notify(surfaceId);
    },
  };
}

/**
 * The store is NULL by default, and that is load-bearing: a surface rendered
 * without the provider keeps its own control instead of losing it. Do not give
 * this a working default.
 */
const SurfaceActionStoreContext = createContext<SurfaceActionStore | null>(null);

export function SurfaceActionProvider({
  store,
  children,
}: {
  store: SurfaceActionStore;
  children: ReactNode;
}) {
  const value = useMemo(() => store, [store]);
  useEffect(() => () => {
    // A route change must not leave a stale slot for the next page to render.
    for (const surfaceId of ["chat", "aeon", "desktop", "files", "git", "box", "terminal", "browser"]) {
      store.release(surfaceId);
    }
  }, [store]);
  return (
    <SurfaceActionStoreContext.Provider value={value}>
      {children}
    </SurfaceActionStoreContext.Provider>
  );
}

export function useSurfaceActionStore(): SurfaceActionStore | null {
  return useContext(SurfaceActionStoreContext);
}

/** One store per agent page, never a module singleton. */
export function useSurfaceActionStoreInstance(): SurfaceActionStore {
  const [store] = useState(createSurfaceActionStore);
  return store;
}

/**
 * Publishes this surface's actions into the bar, or reports that it did not.
 *
 * `active` is required rather than defaulted so a caller cannot omit it and
 * silently publish from a hidden surface.
 */
export function useSurfaceAction(
  surfaceId: string | undefined,
  active: boolean,
  actions: readonly SurfaceAction[],
): { published: boolean } {
  const store = useSurfaceActionStore();
  const actionsRef = useRef(actions);
  // Keep handlers fresh without making them an effect dependency: a new closure
  // every render must not republish, or the bar would re-render in a loop.
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  const signature = actions
    .map((action) => `${action.id}:${action.label}:${action.disabled ? "1" : "0"}`)
    .join("|");

  useEffect(() => {
    if (!store || !active || surfaceId === undefined) return;
    store.publish(surfaceId, [...actionsRef.current]);
    return () => store.release(surfaceId);
  }, [store, active, surfaceId, signature]);

  return { published: Boolean(store) && active && surfaceId !== undefined };
}
