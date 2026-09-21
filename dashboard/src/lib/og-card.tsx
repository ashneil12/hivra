// Shared renderer for the public marketing Open Graph / Twitter cards
// (#public-og-images). One branded 1200x630 card used by the file-based
// opengraph-image.tsx segments for the apex, /changelog and /status pages.
//
// Pure presentational image generation for PUBLIC pages only — no auth, no
// tenant/per-instance data ever reaches a card. Mirrors the ImageResponse
// brand language already used by app/apple-icon.tsx + app/pwa-icon-512
// (lime #ccff00 mark on near-black #111111).

import { ImageResponse } from "next/og";

import { OG_SIZE } from "@/lib/og-meta";

// Brand tokens (kept literal so the edge ImageResponse runtime needs no CSS vars).
const BG = "#111111";
const ACCENT = "#ccff00";
const INK = "#fdfcf9";
const MUTED = "#a3a3a3";

export interface OgCardInput {
  // Small uppercase label above the title (e.g. "Changelog", "Status"); omit on the apex card.
  eyebrow?: string;
  title: string;
  subtitle: string;
}

// Builds the branded OG card as a Next.js ImageResponse. Returned from each
// opengraph-image.tsx default export.
export function renderOgCard({ eyebrow, title, subtitle }: OgCardInput): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BG,
          padding: "72px 80px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Brand row: lime "H" mark + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 96,
              height: 96,
              borderRadius: 24,
              background: ACCENT,
              color: "#111111",
              fontSize: 72,
              fontWeight: 900,
              letterSpacing: "-0.08em",
            }}
          >
            H
          </div>
          <span
            style={{
              color: INK,
              fontSize: 44,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            Hivra
          </span>
        </div>

        {/* Headline block */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {eyebrow ? (
            <span
              style={{
                color: ACCENT,
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                marginBottom: 20,
              }}
            >
              {eyebrow}
            </span>
          ) : null}
          <span
            style={{
              color: INK,
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </span>
          <span
            style={{
              color: MUTED,
              fontSize: 36,
              fontWeight: 400,
              lineHeight: 1.3,
              marginTop: 28,
            }}
          >
            {subtitle}
          </span>
        </div>

        {/* Footer URL */}
        <span style={{ color: MUTED, fontSize: 28, fontWeight: 500 }}>hivra.cloud</span>
      </div>
    ),
    { ...OG_SIZE }
  );
}
