// Social card for one blog article (app/blog/[slug]/opengraph-image.tsx).
//
// Same brand frame as the shared public card in lib/og-card.tsx (dark ground,
// the approved Hivra mark, red eyebrow, hivra.cloud footer), with one
// difference that matters for articles: the title size steps down with length.
// The shared card sets one 76px title size for short marketing headlines; blog
// titles run to 80 characters and would overflow the 630px card at that size.
//
// Pure presentational rendering for public pages. No request data reaches it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { OG_SIZE } from "@/lib/og-meta";

// Brand tokens, kept literal so the ImageResponse renderer needs no CSS vars.
// These match lib/og-card.tsx.
const BG = "#111111";
const ACCENT = "#ff3a3b";
const INK = "#fdfcf9";
const MUTED = "#a3a3a3";

const MARK_PATH = join(process.cwd(), "public/brand/hivra-icon-192.png");
const MARK_SIZE = 88;

/** Title font size for a card title of this length, so up to ~90 characters fits. */
export function blogCardTitleSize(title: string): number {
  if (title.length > 70) return 52;
  if (title.length > 45) return 62;
  return 76;
}

export interface BlogCardInput {
  title: string;
  readingTimeMin?: number;
}

async function readMarkDataUri(): Promise<string> {
  const bytes = await readFile(MARK_PATH);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export async function renderBlogCard({ title, readingTimeMin }: BlogCardInput): Promise<ImageResponse> {
  const mark = await readMarkDataUri();
  const titleSize = blogCardTitleSize(title);

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
          padding: "64px 80px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>, not next/image */}
          <img src={mark} width={MARK_SIZE} height={MARK_SIZE} alt="" />
          <span style={{ color: INK, fontSize: 42, fontWeight: 700, letterSpacing: "0.04em" }}>Hivra</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <span
            style={{
              color: ACCENT,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              marginBottom: 20,
            }}
          >
            From the blog
          </span>
          <span
            style={{
              color: INK,
              fontSize: titleSize,
              fontWeight: 800,
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: MUTED, fontSize: 28, fontWeight: 500 }}>hivra.cloud/blog</span>
          {readingTimeMin ? (
            <span style={{ color: MUTED, fontSize: 28, fontWeight: 500 }}>{`${readingTimeMin} min read`}</span>
          ) : null}
        </div>
      </div>
    ),
    { ...OG_SIZE }
  );
}
