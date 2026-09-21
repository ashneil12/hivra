import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ccff00",
          color: "#111111",
          fontSize: 128,
          fontWeight: 900,
          fontFamily: "system-ui, sans-serif",
          borderRadius: 40,
          letterSpacing: "-0.08em",
        }}
      >
        H
      </div>
    ),
    size
  );
}
