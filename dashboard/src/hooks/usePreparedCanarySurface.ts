"use client";

import { useSyncExternalStore } from "react";

import { preparedCanarySurfaceAvailable } from "@/lib/hivra/hivra-flag";

const subscribe = () => () => {};

/** Whether this deployment can serve the prepared Canary computers (Omarchy,
 * and Windows' prepared claim). The server snapshot keeps the first render
 * identical to the server, then the client reads the real hostname: no
 * hydration mismatch and no synchronous setState inside an effect. */
export function usePreparedCanarySurface(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => preparedCanarySurfaceAvailable(),
    () => false,
  );
}
