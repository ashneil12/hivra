// Shared renderer for the public marketing Open Graph / Twitter cards
// (#public-og-images). One branded 1200x630 card used by the file-based
// opengraph-image.tsx segments for the apex, /changelog and /status pages.
//
// Pure presentational image generation for PUBLIC pages only — no auth, no
// tenant/per-instance data ever reaches a card. The brand row shows the approved
// Hivra mark (docs/brand/hivra-logo.jpg) exactly as exported to the app icons by
// docs/brand/export-brand-assets.py; it is never redrawn here.
//
// The segments use the Node.js runtime because the mark is read from public/.
// They call no dynamic APIs, so Next.js prerenders each card at build time.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { OG_SIZE } from "@/lib/og-meta";

// Brand tokens (kept literal so the ImageResponse renderer needs no CSS vars).
// ACCENT is the dark-theme --hivra-red from app/globals.css.
const BG = "#111111";
const ACCENT = "#ff3a3b";
const INK = "#fdfcf9";
const MUTED = "#a3a3a3";

// The 192px app icon, drawn at 96px so the downscale stays an exact 2x.
const MARK_PATH = join(process.cwd(), "public/brand/hivra-icon-192.png");
const MARK_SIZE = 96;

async function readMarkDataUri(): Promise<string> {
  const bytes = await readFile(MARK_PATH);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export interface OgCardInput {
  // Small uppercase label above the title (e.g. "Changelog", "Status"); omit on the apex card.
  eyebrow?: string;
  title: string;
  subtitle: string;
}

// Builds the branded OG card as a Next.js ImageResponse. Returned from each
// opengraph-image.tsx default export.
export async function renderOgCard({ eyebrow, title, subtitle }: OgCardInput): Promise<ImageResponse> {
  const mark = await readMarkDataUri();
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
        {/* Brand row: approved Hivra mark + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>, not next/image */}
          <img
            src={mark}
            width={MARK_SIZE}
            height={MARK_SIZE}
            alt=""
          />
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
