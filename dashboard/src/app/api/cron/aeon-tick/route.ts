import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

const ROUTE = "/api/cron/aeon-tick";
const SOURCE = "aeon-tick";

// Drive the Aeon scheduler's cadence.
//
// The Aeon framework (ashneil12/aeon `messages.yml`) only evaluates its
// per-skill crons (in aeon.yml) when it receives a `repository_dispatch` of
// type `cron-tick`; its own native GitHub `schedule:` triggers are unreliable
// because the repo is a FORK (of aaronjmars/aeon) and GitHub throttles/disables
// scheduled workflows on forks. So we send the tick from here on a reliable
// Vercel cron instead.
//
// This is dumb-by-design: it fires the tick unconditionally every run. Aeon's
// OWN gate job calls back to /api/instances/<id>/aeon-gate to decide whether to
// actually do any work (skipped when the instance is paused/stopped), so this
// route must NOT replicate that gating — it would double-gate and could mask a
// real outage. One dispatch per cron tick; the scheduler + its 90m dedup handle
// which skills (if any) are due.
const DEFAULT_AEON_REPO = "ashneil12/aeon";
const DISPATCH_TIMEOUT_MS = 8_000;

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      { source: SOURCE, route: ROUTE, method: "GET", failureType: "cron_secret_missing" },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  // A GitHub token (fine-grained: `contents: write` on the Aeon repo, OR a
  // classic PAT with `repo`) authorized to POST repository_dispatch events.
  // Set as the AEON_DISPATCH_GITHUB_TOKEN env var in the dashboard project.
  const token = process.env.AEON_DISPATCH_GITHUB_TOKEN?.trim();
  if (!token) {
    log.error(
      "AEON_DISPATCH_GITHUB_TOKEN is not configured; cannot tick Aeon",
      new Error("aeon dispatch token missing"),
      { source: SOURCE, route: ROUTE, failureType: "aeon_dispatch_token_missing" },
    );
    return apiError("Aeon dispatch token is not configured", 500);
  }

  const aeonRepo = process.env.AEON_DISPATCH_REPO?.trim() || DEFAULT_AEON_REPO;
  const url = `https://api.github.com/repos/${aeonRepo}/dispatches`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "hermesos-aeon-tick",
      },
      body: JSON.stringify({ event_type: "cron-tick" }),
      signal: controller.signal,
    });

    // GitHub returns 204 No Content on a successful dispatch.
    if (res.status !== 204) {
      const detail = await res.text().catch(() => "");
      log.error(
        "Aeon cron-tick dispatch rejected by GitHub",
        new Error(`github dispatch ${res.status}`),
        {
          source: SOURCE,
          route: ROUTE,
          failureType: "aeon_dispatch_failed",
          status: res.status,
          repo: aeonRepo,
          detail: detail.slice(0, 300),
        },
      );
      // Token revocation / expiry would 401/403 here every tick and silently
      // turn Aeon dark — previously only on Aeon's own Discord, never the
      // dashboard feed. Surface it (deduped by fingerprint, so a persistent
      // failure pages once, not every 15 min).
      await reportOpsEvent({
        source: "cron.aeon-tick",
        severity: "warn",
        title: `Aeon cron-tick dispatch rejected by GitHub (${res.status})`,
        message:
          `GitHub rejected the Aeon repository_dispatch with status ${res.status} for ${aeonRepo}. ` +
          `A 401/403 usually means AEON_DISPATCH_GITHUB_TOKEN expired or was revoked. While this ` +
          `persists, Aeon's per-skill crons stop evaluating.`,
        route: ROUTE,
        metadata: {
          failureType: "aeon_dispatch_failed",
          status: res.status,
          repo: aeonRepo,
        },
      });
      return apiError(`GitHub dispatch failed (${res.status})`, 502);
    }

    return apiSuccess({ dispatched: true, repo: aeonRepo, event: "cron-tick" });
  } catch (error) {
    log.error("Aeon cron-tick dispatch threw", error, {
      source: SOURCE,
      route: ROUTE,
      failureType: "aeon_dispatch_exception",
      repo: aeonRepo,
    });
    await reportOpsEvent({
      source: "cron.aeon-tick",
      severity: "warn",
      title: "Aeon cron-tick dispatch threw",
      message:
        `The Aeon repository_dispatch to ${aeonRepo} threw (timeout or network error). Aeon's ` +
        `scheduler tick did not fire this run; if it persists Aeon stops evaluating its crons.`,
      route: ROUTE,
      metadata: {
        failureType: "aeon_dispatch_exception",
        repo: aeonRepo,
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Aeon dispatch error", 502);
  } finally {
    clearTimeout(timer);
  }
}
