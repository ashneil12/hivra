import { DESKTOP_STREAMING_MODE_DETAILS, type DesktopStreamingMode } from "./streaming-mode-preference";

export type WindowsDesktopViewport = { width: number; height: number };

// Treat quality as a pixel budget, not a forced 16:9 display. Windows changes
// its actual desktop geometry; the viewer never crops or stretches the image.
export function windowsDesktopDimensions(mode: DesktopStreamingMode, viewport?: WindowsDesktopViewport) {
  const profile = DESKTOP_STREAMING_MODE_DETAILS[mode];
  if (!viewport) return { width: profile.width, height: profile.height };
  if (![viewport.width, viewport.height].every(value => Number.isInteger(value) && value >= 1 && value <= 16_384)) return null;
  const widthLimit = Math.floor(profile.width / 64) * 64;
  const heightLimit = Math.floor(profile.height / 64) * 64;
  const scale = Math.min(widthLimit / viewport.width, heightLimit / viewport.height);
  // The observed Windows gateway rounds both canvas axes up to 64px blocks.
  // Request those blocks ourselves so Guacamole's initial fit scale uses the
  // same geometry as the actual canvas (otherwise the rounded edge is cropped).
  const width = Math.floor(viewport.width * scale / 64) * 64;
  const height = Math.min(heightLimit,
    Math.round(width * viewport.height / viewport.width / 64) * 64);
  // Keep the aligned canvas above RDP's 200px minimum on both axes.
  if (width < 256 || height < 256) return null;
  return { width, height };
}
