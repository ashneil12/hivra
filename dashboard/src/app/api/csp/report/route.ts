import { NextRequest, NextResponse } from "next/server";

import { reportOpsEvent } from "@/lib/ops-events";

// SCRIPTURE_ANCHOR: csp-shield | Psalm 5:12 | Verse: For you will bless the righteous. Yahweh, you will surround him with favor as with a shield.
/**
 * CSP violation report receiver. Browsers POST here every time a
 * directive in our CSP would have blocked (or did block) a load.
 * Wired up via `report-uri` in next.config.ts; older browsers send
 * `application/csp-report`, newer browsers + the Reporting API send
 * `application/reports+json` (a batched array). Accept both.
 *
 * Why this exists: today's debug session had a 6-hour stretch where
 * Chrome was CSP-blocking the SW's cross-origin GET to the agent
 * gateway, but the only signal in DevTools was a "CORS error" badge.
 * No server-side trace until you reproduce in a browser with the
 * console open. With report-uri, every CSP violation lands in the
 * ops-events table the moment any user trips it — including SW
 * fetches, since SW response-header CSPs also report when given a
 * report-uri / report-to.
 *
 * Auth: this endpoint MUST be reachable without Clerk credentials —
 * browsers don't attach cookies to CSP reports. The proxy
 * middleware allow-lists this path (it isn't in PROTECTED_ROUTE_MATCHERS).
 *
 * Trust model: anyone on the internet can POST anything here. We
 * shape a sanitized event from a fixed set of fields and let
 * reportOpsEvent's existing redaction + length caps protect the DB.
 * Body parsing is best-effort — malformed payloads silently 204 so
 * a noisy attacker can't fill our logs with parse errors.
 */
export const dynamic = "force-dynamic";

// Hard cap on how many violations we will fan out to ops-events from a
// single POST. Public, unauthed endpoint — without this, an attacker
// posting a giant batched array drives one DB write per element.
const MAX_REPORTS_PER_REQUEST = 16;

interface CspReportFields {
  blockedUri?: string;
  documentUri?: string;
  violatedDirective?: string;
  effectiveDirective?: string;
  disposition?: string;
  originalPolicy?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
}

function asString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize one violation across the two on-the-wire shapes:
 *   - application/csp-report (Level 2): { "csp-report": { ... } }
 *     with kebab-case keys (`blocked-uri`, etc).
 *   - application/reports+json (Level 3 / Reporting API):
 *     [{ type: "csp-violation", body: { ... } }]
 *     with camelCase keys (`blockedURL`, `originalPolicy`).
 */
function normalize(report: unknown): CspReportFields | null {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }
  const r = report as Record<string, unknown>;
  return {
    blockedUri: asString(r["blocked-uri"] ?? r.blockedURL ?? r.blockedUri),
    documentUri: asString(r["document-uri"] ?? r.documentURL ?? r.documentUri),
    violatedDirective: asString(r["violated-directive"] ?? r.violatedDirective),
    effectiveDirective: asString(r["effective-directive"] ?? r.effectiveDirective),
    disposition: asString(r.disposition, 32),
    originalPolicy: asString(r["original-policy"] ?? r.originalPolicy, 2000),
    sourceFile: asString(r["source-file"] ?? r.sourceFile),
    lineNumber: asNumber(r["line-number"] ?? r.lineNumber),
    columnNumber: asNumber(r["column-number"] ?? r.columnNumber),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Malformed payload — silently accept so attackers can't blow up
    // logs by spamming garbage. Real browsers always send valid JSON.
    return new NextResponse(null, { status: 204 });
  }

  // Two shapes supported. Newer Reporting API sends an array of
  // { type: "csp-violation", body: {...} }; older browsers send a
  // single { "csp-report": {...} } object.
  const candidates: unknown[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (candidates.length >= MAX_REPORTS_PER_REQUEST) break;
      if (entry && typeof entry === "object" && "body" in entry) {
        candidates.push((entry as { body: unknown }).body);
      }
    }
  } else if (body && typeof body === "object" && "csp-report" in body) {
    candidates.push((body as { "csp-report": unknown })["csp-report"]);
  } else {
    candidates.push(body);
  }

  for (const candidate of candidates) {
    const fields = normalize(candidate);
    if (!fields) continue;

    // The directive name is the most useful single signal — `connect-src`,
    // `script-src`, etc. — for what TYPE of resource was blocked. The
    // blocked-uri tells us WHICH resource. Both flow into the title for
    // quick scanning in the ops view.
    const directive = fields.effectiveDirective || fields.violatedDirective || "<unknown>";
    const blocked = fields.blockedUri || "<inline>";

    await reportOpsEvent({
      source: "csp-report",
      severity: fields.disposition === "enforce" ? "error" : "warn",
      title: `CSP ${fields.disposition || "report"}: ${directive}`,
      message: `Blocked ${blocked} on ${fields.documentUri || "<unknown>"}`,
      route: fields.documentUri,
      metadata: {
        directive,
        blockedUri: fields.blockedUri,
        documentUri: fields.documentUri,
        sourceFile: fields.sourceFile,
        lineNumber: fields.lineNumber,
        columnNumber: fields.columnNumber,
        disposition: fields.disposition,
      },
    });
  }

  // Browsers don't act on the response body and we don't want to leak
  // anything either way; 204 is the canonical reply to a CSP report.
  return new NextResponse(null, { status: 204 });
}
