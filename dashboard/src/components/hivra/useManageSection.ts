"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isManageSectionId, type ManageSectionId } from "@/lib/hivra/manage-sections";

// Links that predate sections point at an anchor inside Manage. Each anchor
// belongs to one section, which opens before the page scrolls to it.
const ANCHOR_SECTION: Record<string, ManageSectionId> = {
  resources: "resources",
  "model-settings": "model",
  "private-access": "network",
  danger: "advanced",
  "agent-software": "updates",
};

function readUrl(): URL | null {
  try { return new URL(window.location.href); } catch { return null; }
}

/** The section a Manage URL asks for, and the anchor to scroll to inside it. */
export function requestedManageSection(url: URL): { section: ManageSectionId | null; invalid: boolean; anchor: string | null } {
  const raw = url.searchParams.get("section");
  const anchor = url.hash.replace(/^#/, "").split("#")[0] || null;
  if (raw !== null) {
    return isManageSectionId(raw) ? { section: raw, invalid: false, anchor } : { section: null, invalid: true, anchor };
  }
  if (anchor && ANCHOR_SECTION[anchor]) return { section: ANCHOR_SECTION[anchor], invalid: false, anchor };
  if (url.searchParams.get("tools") === "1") return { section: "model", invalid: false, anchor };
  if (url.searchParams.get("addAgent") === "1") return { section: "agents", invalid: false, anchor };
  return { section: null, invalid: false, anchor };
}

function scrollToAnchor(anchor: string | null): number | null {
  if (!anchor) return null;
  return window.requestAnimationFrame(() => {
    const target = document.getElementById(anchor);
    // An anchor inside a hidden section can't be scrolled to; its section opens first.
    if (target && !target.closest("[hidden]") && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
  });
}

/**
 * Which Manage section is open. Deep links: ?tab=manage&section=<id>, plus the
 * older anchors (#resources, #model-settings, #private-access, #danger),
 * ?tools=1 (Model & tools) and ?addAgent=1 (Agents). A section this computer
 * doesn't have falls back to Overview, and the URL is corrected in place.
 * Choosing a section replaces the URL (no Back entry per click, like the page's
 * own tabs); Back and Forward from other pages re-read it.
 *
 * `ready` is false while the section list is only a placeholder, so a deep
 * link isn't discarded before the computer's real sections are known.
 */
export function useManageSection(sections: readonly ManageSectionId[], ready = true) {
  const [selected, setSelected] = useState<ManageSectionId>("overview");
  const frame = useRef<number | null>(null);
  const key = sections.join(",");

  useEffect(() => {
    const allowed = key.split(",") as ManageSectionId[];
    const sync = () => {
      const url = readUrl();
      if (!url) return;
      if (url.hash === "#resources#resources") {
        url.hash = "resources";
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      const request = requestedManageSection(url);
      const valid = request.section !== null && allowed.includes(request.section);
      setSelected(valid ? request.section as ManageSectionId : "overview");
      if (ready && url.searchParams.has("section") && (!valid || request.invalid)) {
        url.searchParams.delete("section");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = valid ? scrollToAnchor(request.anchor) : null;
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, [key, ready]);

  const select = useCallback((section: ManageSectionId) => {
    setSelected(section);
    const url = readUrl();
    if (!url) return;
    url.searchParams.set("section", section);
    // An anchor that belongs to another section no longer describes the view.
    const anchor = url.hash.replace(/^#/, "");
    if (anchor && ANCHOR_SECTION[anchor] !== section) url.hash = "";
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  return { selected, select };
}
