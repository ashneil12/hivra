import React from "react";
import { ImageResponse } from "next/og";

export const runtime = "edge";

export function GET() {
  return new ImageResponse(
    React.createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ccff00",
          color: "#111111",
          fontSize: 138,
          fontWeight: 900,
          fontFamily: "system-ui, sans-serif",
          borderRadius: 48,
          letterSpacing: "-0.08em",
        },
      },
      "H"
    ),
    {
      width: 192,
      height: 192,
      // The icon is deterministic, so let the CDN/browser cache it long-term
      // instead of invoking this edge function on every install-icon fetch.
      headers: {
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    }
  );
}
