import { NextRequest } from "next/server";

import { verifyBearerHeader } from "@/lib/bearer-auth";
import { decryptApiKey } from "@/lib/crypto";
import { loadBoxRelease } from "@/lib/hermes-releases/box";
import { DIGEST_PATTERN } from "@/lib/hermes-releases/policy";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,200}$/;

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * GET /api/u/[id]/release: the box's update stack asks which image to run.
 *
 * Lives outside /api/instances (Clerk-protected) like the update-report alias;
 * the box authenticates with its own api_server_key bearer. The reply is plain
 * key=value lines the roll script reads with sed:
 *
 *   action=legacy the registry has no release of this repository yet: follow the floating tag as before
 *   action=roll   run `image` (repo@sha256:...), then report the outcome
 *   action=none   the box is already on its target, or this sweep must not move it
 *   action=hold   no release is offered (nothing registered, or all halted)
 *
 * The box sends `repo` (the repository its compose runs) and `cur` (the digest
 * it measured running); both are optional. Unknown or failing lookups answer
 * `hold`, so a roller that cannot reach a decision never falls back to a
 * floating tag.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!supabaseAdmin) return text("action=hold\nreason=database_not_configured\n", 503);
  const { id } = await params;

  const { data: row } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, api_server_key_encrypted")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; api_server_key_encrypted: string | null }>();
  if (!row?.api_server_key_encrypted) return text("action=hold\nreason=unauthorized\n", 401);
  if (!verifyBearerHeader(req.headers.get("authorization"), decryptApiKey(row.api_server_key_encrypted))) {
    return text("action=hold\nreason=unauthorized\n", 401);
  }

  const repoParam = req.nextUrl.searchParams.get("repo")?.trim() ?? "";
  const curParam = req.nextUrl.searchParams.get("cur")?.trim() ?? "";
  try {
    const state = await loadBoxRelease(supabaseAdmin, id, {
      imageRepo: REPO_PATTERN.test(repoParam) ? repoParam : null,
      reportedDigest: DIGEST_PATTERN.test(curParam) ? curParam : null,
    });
    if (state && !state.governed) return text("action=legacy\n");
    const target = state?.decision.target;
    if (!state || !target) return text("action=hold\nreason=no_release\n");
    if (!state.decision.autoMove) return text(`action=none\ndigest=${target.digest}\nversion=${target.version}\n`);
    return text(
      [
        "action=roll",
        `image=${state.targetImage}`,
        `digest=${target.digest}`,
        `version=${target.version}`,
        `direction=${state.decision.direction}`,
        "",
      ].join("\n")
    );
  } catch (err) {
    log.error("release lookup for box failed", err instanceof Error ? err : new Error(String(err)), {
      source: "u-release",
      failureType: "box_release_lookup_failed",
      instanceId: id,
    });
    return text("action=hold\nreason=lookup_failed\n", 500);
  }
}
