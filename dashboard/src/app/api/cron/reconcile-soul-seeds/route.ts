import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  runSoulSeedReconcile,
  type SoulSeedReconcileSummary,
} from "@/lib/recovery/soul-seed-reconcile";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Post-provision SOUL.md reconcile — the out-of-band path that closes the seed
 * race #475 couldn't (see src/lib/recovery/soul-seed-reconcile.ts).
 *
 * For each RUNNING webfree Hermes-lane box, read /home/hermes/.hermes/SOUL.md
 * and, IF it's still empty / the factory default / an un-run onboarding ritual,
 * re-seed the intended soul (the hired persona soul, else the who-am-I ritual).
 * Guard-protected + idempotent: it never clobbers an authored identity, so it
 * self-heals every already-broken factory-default box and is safe to re-run.
 *
 * GET  — scheduled whole-fleet sweep (Vercel cron; also the "one-time reconcile
 *        pass over the current fleet" — just hit it once).
 * POST — targeted `{ instanceIds: [...] }` reconcile for specific boxes.
 *
 * Both are CRON_SECRET-gated (Authorization: Bearer ${CRON_SECRET}).
 */
export const dynamic = "force-dynamic";

// One SSH read per box (+ at most one guarded write for the few that need
// re-seeding) at concurrency 8 clears a ~150-box fleet well inside this, but
// give it real headroom so a batch of slow hosts can't truncate the tail.
export const maxDuration = 300;

const SOURCE = "cron/reconcile-soul-seeds";
const ROUTE = "/api/cron/reconcile-soul-seeds";
// Guardrail on the targeted POST path so a caller can't fan out an unbounded SSH
// sweep; the scheduled GET sweep covers the whole fleet on its own.
const MAX_TARGETED_IDS = 50;

function parseInstanceIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const raw =
    (body as { instanceIds?: unknown }).instanceIds ??
    (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) return null;

  const ids = Array.from(
    new Set(
      raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  return ids.length > 0 ? ids : null;
}

/**
 * Surface real problems without paging on the expected. A run that RE-SEEDED
 * boxes (reseeded* > 0) means the provision-time seed lost the race on live
 * boxes — worth a heads-up but benign (this cron just fixed them). Per-box
 * errors are the real signal that the reconcile path itself is degraded.
 */
async function reportOutcome(summary: SoulSeedReconcileSummary): Promise<void> {
  if (summary.errored > 0) {
    await reportOpsEvent({
      source: "cron.reconcile_soul_seeds_errors",
      severity: "warn",
      title: `SOUL reconcile: ${summary.errored} box(es) errored`,
      message:
        `reconcile-soul-seeds scanned ${summary.scanned} running webfree box(es): ` +
        `re-seeded ${summary.reseededPersona} persona + ${summary.reseededRitual} ritual, ` +
        `${summary.errored} errored. A persistent error rate means boxes may be stuck on the ` +
        `factory-default SOUL.md — check SSH host health + the failed instances' agent container.`,
      route: ROUTE,
      metadata: {
        scanned: summary.scanned,
        reseeded_persona: summary.reseededPersona,
        reseeded_ritual: summary.reseededRitual,
        errored: summary.errored,
        capped: summary.capped,
        errored_instances: summary.results
          .filter((r) => r.action === "error")
          .slice(0, 20)
          .map((r) => ({ id: r.id, error: r.error })),
      },
    });
    return;
  }

  // A capped run left boxes unscanned this tick — not an error, but don't let it
  // read as "whole fleet covered". The next tick advances; flag it so a fleet
  // that outgrew the cap is visible rather than silently under-covered.
  if (summary.capped) {
    await reportOpsEvent({
      source: "cron.reconcile_soul_seeds_capped",
      severity: "warn",
      title: "SOUL reconcile hit the per-run fleet cap",
      message:
        `reconcile-soul-seeds scanned its per-run limit of ${summary.scanned} box(es) and did NOT ` +
        `cover the whole fleet this tick. Subsequent ticks advance, but a fleet that persistently ` +
        `exceeds the cap should raise the limit or shorten the schedule.`,
      route: ROUTE,
      metadata: { scanned: summary.scanned },
    });
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const summary = await runSoulSeedReconcile();
    await reportOutcome(summary);

    // Dead-man heartbeat: the sweep ran to completion (per-box failures live in
    // `results`, not a route-level failure). Best-effort.
    await recordCronHeartbeat("reconcile-soul-seeds");

    return apiSuccess({ mode: "fleet-sweep", ...summary });
  } catch (err) {
    log.error("soul-seed reconcile fleet sweep failed", err, {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "soul_seed_reconcile_failed",
    });
    const message = err instanceof Error ? err.message : "SOUL reconcile failed";
    return apiError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const instanceIds = parseInstanceIds(body);
  if (!instanceIds) {
    return apiError("Pass instanceIds as a non-empty array", 400);
  }
  if (instanceIds.length > MAX_TARGETED_IDS) {
    return apiError(`At most ${MAX_TARGETED_IDS} instances can be reconciled at once`, 400);
  }

  try {
    const summary = await runSoulSeedReconcile({ instanceIds });
    await reportOutcome(summary);
    return apiSuccess({ mode: "targeted", requested: instanceIds.length, ...summary });
  } catch (err) {
    log.error("soul-seed reconcile targeted run failed", err, {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "soul_seed_reconcile_failed",
    });
    const message = err instanceof Error ? err.message : "SOUL reconcile failed";
    return apiError(message, 500);
  }
}
