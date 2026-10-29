"use client";

// Agent-written markdown can point an image at any URL. A rendered <img> makes
// the browser request that URL as soon as the reply is shown, so an injected
// reply could carry chat or workspace text out in its query string with no
// click. A remote image therefore waits behind a placeholder that shows its
// alt text and host, and loads only when the owner asks for it. Inline PNG,
// JPEG, GIF and WebP data URLs need no request and render directly.

import { useState } from "react";

const INLINE_RASTER_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);/i;

function imageSourceLabel(src: string): string {
  if (src.startsWith("/") && !src.startsWith("//")) return "this app";
  try {
    return new URL(src).host || "an unknown host";
  } catch {
    return "an unknown host";
  }
}

// react-markdown types an image source as string | Blob; only a string can name a URL.
export function AgentMarkdownImage({ src: rawSrc, alt }: { src?: string | Blob; alt?: string }) {
  const [loadRequested, setLoadRequested] = useState(false);
  const label = alt?.trim() || "Image";
  const src = typeof rawSrc === "string" ? rawSrc : "";
  if (src.length === 0) {
    return <span>{label}</span>;
  }
  if (loadRequested || INLINE_RASTER_IMAGE.test(src)) {
    // next/image would route the URL through the optimizer; this must be the browser fetching the owner-chosen URL.
    // eslint-disable-next-line @next/next/no-img-element -- a plain img is the owner-approved fetch
    return <img src={src} alt={alt ?? ""} loading="lazy" />;
  }
  return (
    <button
      type="button"
      onClick={() => setLoadRequested(true)}
      title={`Load image from ${imageSourceLabel(src)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        padding: "4px 8px",
        border: "1px dashed var(--etched-border)",
        background: "var(--bg-elevated)",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-mono), monospace",
        fontSize: "0.85em",
        cursor: "pointer",
        overflowWrap: "anywhere",
        textAlign: "left",
      }}
    >
      {label} · Load image from {imageSourceLabel(src)}
    </button>
  );
}

/** The image override every renderer of agent-written markdown spreads in. */
export const AGENT_MARKDOWN_COMPONENTS = { img: AgentMarkdownImage };
