"use client";

import { useEffect } from "react";

/**
 * PreloadHandler is a utility component that removes the 'preload' class from 
 * the body after the application has mounted for the first time.
 * This prevents CSS transitions (like theme-switching animations) from 
 * triggering on the initial data fetch and hydration.
 */
export function PreloadHandler() {
  useEffect(() => {
    const timeout = setTimeout(() => {
        document.body.classList.remove("preload");
    }, 100);
    return () => clearTimeout(timeout);
  }, []);

  return null;
}
