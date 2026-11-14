"use client";

import { useEffect } from "react";
import { attributionFromParams, captureVeniceAttribution } from "@/lib/venice/attribution";

/**
 * On /venice: remembers that the visit came from Venice (ref=venice unless the
 * link says otherwise) and any ?code=, before sign-in sends the visitor away.
 */
export default function VeniceAttributionCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const found = attributionFromParams(key => params.get(key));
    captureVeniceAttribution({ ref: found.ref ?? "venice", code: found.code });
  }, []);
  return null;
}
