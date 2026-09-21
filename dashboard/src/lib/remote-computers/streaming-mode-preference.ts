export const DESKTOP_STREAMING_MODES = ["hq", "qhd", "uhd", "performance"] as const;

export type DesktopStreamingMode = typeof DESKTOP_STREAMING_MODES[number];

export const DESKTOP_STREAMING_MODE_DETAILS: Record<DesktopStreamingMode, {
  label: string;
  resolution: string;
  width: number;
  height: number;
  bitrateKbps: number;
  status: string;
}> = {
  hq: { label: "HQ", resolution: "1080p", width: 1920, height: 1080, bitrateKbps: 25_000,
    status: "1080p60 at 25 Mbps" },
  qhd: { label: "QHD", resolution: "1440p", width: 2560, height: 1440, bitrateKbps: 40_000,
    status: "1440p60 at 40 Mbps" },
  uhd: { label: "4K", resolution: "2160p", width: 3840, height: 2160, bitrateKbps: 65_000,
    status: "4K60 at 65 Mbps" },
  performance: { label: "Performance", resolution: "720p", width: 1280, height: 720,
    bitrateKbps: 12_000, status: "720p60 at 12 Mbps" },
};

const STORAGE_PREFIX = "hivra.desktop.stream-mode.v2:";

export function streamModeStorageKey(computerId: string): string {
  return `${STORAGE_PREFIX}${computerId.toLowerCase()}`;
}

export function readStreamModePreference(computerId: string): DesktopStreamingMode {
  if (typeof window === "undefined") return "hq";
  try {
    const stored = window.localStorage.getItem(streamModeStorageKey(computerId));
    return DESKTOP_STREAMING_MODES.includes(stored as DesktopStreamingMode)
      ? stored as DesktopStreamingMode
      : "hq";
  } catch {
    return "hq";
  }
}

export function writeStreamModePreference(computerId: string, mode: DesktopStreamingMode): void {
  try {
    window.localStorage.setItem(streamModeStorageKey(computerId), mode);
  } catch {
    // Storage may be unavailable in a private browser profile. The active
    // desktop still receives the selected mode for its current session.
  }
}
