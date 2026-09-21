import type { RemoteDesktopTransportId } from "./transport-catalog";

export type DesktopLatencyEvidenceClass = "browser-telemetry" | "optical";
export type DesktopMediaRoute = "direct" | "relay" | "websocket";

export interface DesktopLatencySample {
  sequence: number;
  inputToVisibleMs: number;
  rttMs: number;
  jitterMs: number;
  packetLossPercent: number;
  encodeMs: number;
  decodeMs: number;
}

export interface DesktopLatencyCampaign {
  transportId: RemoteDesktopTransportId;
  transportRevision: string;
  adapterRevision: string;
  imageDigest: string;
  profile: string;
  condition: string;
  route: DesktopMediaRoute;
  evidenceClass: DesktopLatencyEvidenceClass;
  samples: readonly DesktopLatencySample[];
  optical?: {
    method: string;
    uncertaintyMs: number;
    recordingSha256: string;
  } | null;
}

export type DesktopLatencyIssueCode =
  | "CONTEXT_INCOMPLETE"
  | "INSUFFICIENT_SAMPLES"
  | "DUPLICATE_SEQUENCE"
  | "INVALID_SAMPLE"
  | "OPTICAL_PROOF_MISSING"
  | "REFERENCE_RTT_EXCEEDED"
  | "P50_BUDGET_EXCEEDED"
  | "P95_BUDGET_EXCEEDED";

export interface DesktopLatencyIssue {
  code: DesktopLatencyIssueCode;
  message: string;
}

export interface DesktopLatencySummary {
  sampleCount: number;
  p50InputToVisibleMs: number | null;
  p95InputToVisibleMs: number | null;
  p99InputToVisibleMs: number | null;
  p95RttMs: number | null;
  evidenceClass: DesktopLatencyEvidenceClass;
  accepted: boolean;
  issues: DesktopLatencyIssue[];
}

const MINIMUM_SAMPLE_COUNT = 200;
const MAX_REFERENCE_RTT_P95_MS = 30;
const MAX_INPUT_TO_VISIBLE_P50_MS = 60;
const MAX_INPUT_TO_VISIBLE_P95_MS = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate one immutable transport/profile/condition campaign. Browser timing
 * can prove browser telemetry only. A physical input-to-visible claim requires
 * optical evidence and includes its uncertainty in the acceptance boundary.
 */
export function assessDesktopLatencyCampaign(
  campaign: DesktopLatencyCampaign,
): DesktopLatencySummary {
  const issues: DesktopLatencyIssue[] = [];
  const requiredContext = [
    campaign.transportRevision,
    campaign.adapterRevision,
    campaign.imageDigest,
    campaign.profile,
    campaign.condition,
  ];

  if (requiredContext.some((value) => value.trim().length === 0)) {
    issues.push({ code: "CONTEXT_INCOMPLETE", message: "Revision, image, profile, and condition are required." });
  }
  if (campaign.samples.length < MINIMUM_SAMPLE_COUNT) {
    issues.push({
      code: "INSUFFICIENT_SAMPLES",
      message: `At least ${MINIMUM_SAMPLE_COUNT} raw input samples are required.`,
    });
  }

  const sequences = new Set<number>();
  let invalidSample = false;
  for (const sample of campaign.samples) {
    if (sequences.has(sample.sequence)) {
      issues.push({ code: "DUPLICATE_SEQUENCE", message: `Duplicate sample sequence ${sample.sequence}.` });
      break;
    }
    sequences.add(sample.sequence);

    if (
      !Number.isInteger(sample.sequence)
      || sample.sequence < 0
      || !isFiniteNonNegative(sample.inputToVisibleMs)
      || !isFiniteNonNegative(sample.rttMs)
      || !isFiniteNonNegative(sample.jitterMs)
      || !isFiniteNonNegative(sample.packetLossPercent)
      || sample.packetLossPercent > 100
      || !isFiniteNonNegative(sample.encodeMs)
      || !isFiniteNonNegative(sample.decodeMs)
    ) {
      invalidSample = true;
    }
  }
  if (invalidSample) {
    issues.push({ code: "INVALID_SAMPLE", message: "Every raw timing field must be finite and non-negative." });
  }

  const optical = campaign.optical;
  if (
    campaign.evidenceClass === "optical"
    && (
      !optical
      || optical.method.trim().length === 0
      || !Number.isFinite(optical.uncertaintyMs)
      || optical.uncertaintyMs < 0
      || !SHA256_PATTERN.test(optical.recordingSha256)
    )
  ) {
    issues.push({
      code: "OPTICAL_PROOF_MISSING",
      message: "Physical latency claims require a method, uncertainty, and SHA-256-pinned raw recording.",
    });
  }

  const inputValues = campaign.samples.map((sample) => sample.inputToVisibleMs);
  const rttValues = campaign.samples.map((sample) => sample.rttMs);
  const p50 = percentile(inputValues, 0.5);
  const p95 = percentile(inputValues, 0.95);
  const p99 = percentile(inputValues, 0.99);
  const p95Rtt = percentile(rttValues, 0.95);
  const uncertaintyMs = campaign.evidenceClass === "optical" && optical ? optical.uncertaintyMs : 0;

  if (p95Rtt != null && p95Rtt > MAX_REFERENCE_RTT_P95_MS) {
    issues.push({
      code: "REFERENCE_RTT_EXCEEDED",
      message: `p95 RTT ${p95Rtt} ms exceeds the ${MAX_REFERENCE_RTT_P95_MS} ms reference budget.`,
    });
  }
  if (p50 != null && p50 + uncertaintyMs > MAX_INPUT_TO_VISIBLE_P50_MS) {
    issues.push({
      code: "P50_BUDGET_EXCEEDED",
      message: `p50 input-to-visible latency plus uncertainty exceeds ${MAX_INPUT_TO_VISIBLE_P50_MS} ms.`,
    });
  }
  if (p95 != null && p95 + uncertaintyMs > MAX_INPUT_TO_VISIBLE_P95_MS) {
    issues.push({
      code: "P95_BUDGET_EXCEEDED",
      message: `p95 input-to-visible latency plus uncertainty exceeds ${MAX_INPUT_TO_VISIBLE_P95_MS} ms.`,
    });
  }

  return {
    sampleCount: campaign.samples.length,
    p50InputToVisibleMs: p50,
    p95InputToVisibleMs: p95,
    p99InputToVisibleMs: p99,
    p95RttMs: p95Rtt,
    evidenceClass: campaign.evidenceClass,
    accepted: issues.length === 0,
    issues,
  };
}
