import "server-only";

// Maker claims on catalog pages.
//
// A catalog page names the project that makes an agent and links its
// repository. Someone from that project proves it by adding a file to that
// repository holding a line Hivra gave them. Hivra reads the file from the
// repository the catalog names, never from an address the person typed, so
// only someone who can change the project's default branch can prove a claim.
//
// A proven claim marks the page as claimed and lets that person read how the
// agent is used on Hivra. Nothing here pays, bills or changes what can be
// launched. Written and read only through the service role
// (public.hivra_catalog_claims has no policies).

import { randomBytes } from "node:crypto";

import {
  CLAIM_FILE_PATH,
  type CatalogClaimView,
  type ClaimCheckResult,
  type MakerNumbers,
} from "@/lib/hivra/catalog-claim-types";
import { PROFILE_DETAILS, type LaunchProfileId } from "@/lib/launch/contracts";
import { catalogSourceRepo } from "@/lib/launch/launch-catalog";
import { supabaseAdmin } from "@/lib/supabase";

const PROOF_HOST = "https://raw.githubusercontent.com";
const PROOF_TIMEOUT_MS = 6_000;
/** A proof is one short line; a file larger than this is not read further. */
const PROOF_MAX_BYTES = 16 * 1024;
const NUMBERS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_TTL_MS = 10 * 60 * 1000;

interface ClaimRow {
  id: string;
  user_id: string;
  repo: string;
  token: string;
  status: "pending" | "verified";
  check_result: ClaimCheckResult | null;
  checked_at: string | null;
  verified_at: string | null;
}

interface UseRow {
  agent_type: string;
  people: number;
  active_hours: number;
  launches: number;
  running_now: number;
  two_week_launches: number;
  two_week_kept: number;
}

const CLAIM_COLUMNS = "id, user_id, repo, token, status, check_result, checked_at, verified_at";

/** The repository a page's proof is read from: the one its catalog entry links. */
export function claimRepo(profileId: LaunchProfileId): string | null {
  return catalogSourceRepo(profileId);
}

export function claimLine(token: string): string {
  return `hivra-claim=${token}`;
}

/** True when the file holds the claim's line on a line of its own. */
export function proofHasLine(text: string, token: string): boolean {
  const wanted = claimLine(token);
  return text.split(/\r?\n/).some(line => line.trim() === wanted);
}

function db() {
  if (!supabaseAdmin) throw new Error("Catalog claims need the database.");
  return supabaseAdmin;
}

async function myClaim(userId: string, profileId: LaunchProfileId): Promise<ClaimRow | null> {
  const { data, error } = await db()
    .from("hivra_catalog_claims")
    .select(CLAIM_COLUMNS)
    .eq("profile_id", profileId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Could not read the claim.");
  return (data as ClaimRow | null) ?? null;
}

async function isClaimed(profileId: LaunchProfileId): Promise<boolean> {
  const { data, error } = await db()
    .from("hivra_catalog_claims")
    .select("id")
    .eq("profile_id", profileId)
    .eq("status", "verified")
    .limit(1);
  if (error) throw new Error("Could not read the page's claims.");
  return Array.isArray(data) && data.length > 0;
}

async function readUseByType(now: Date): Promise<UseRow[]> {
  const { data, error } = await db().rpc("hivra_catalog_use_by_type", {
    p_from: new Date(now.getTime() - NUMBERS_DAYS * DAY_MS).toISOString(),
    p_to: now.toISOString(),
  });
  if (error) throw new Error("Could not read use per agent type.");
  return Array.isArray(data) ? (data as UseRow[]) : [];
}

const count = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

async function makerNumbers(profileId: LaunchProfileId, now: Date): Promise<MakerNumbers> {
  const type = PROFILE_DETAILS[profileId].runtimeId;
  const row = (await readUseByType(now)).find(entry => entry.agent_type === type);
  return {
    days: NUMBERS_DAYS,
    people: count(row?.people),
    launches: count(row?.launches),
    activeHours: count(row?.active_hours),
    runningNow: count(row?.running_now),
    twoWeekLaunches: count(row?.two_week_launches),
    twoWeekKept: count(row?.two_week_kept),
  };
}

function view(profileId: LaunchProfileId, mine: ClaimRow | null, claimed: boolean, numbers: MakerNumbers | null): CatalogClaimView {
  return {
    profileId,
    name: PROFILE_DETAILS[profileId].name,
    repo: claimRepo(profileId),
    filePath: CLAIM_FILE_PATH,
    claimed,
    mine: mine ? {
      status: mine.status,
      line: claimLine(mine.token),
      lastCheck: mine.check_result,
      checkedAt: mine.checked_at,
      verifiedAt: mine.verified_at,
    } : null,
    numbers,
  };
}

/** What the signed-in person may know about a page's claim. */
export async function readClaimView(userId: string, profileId: LaunchProfileId, now: Date = new Date()): Promise<CatalogClaimView> {
  if (!claimRepo(profileId)) return view(profileId, null, false, null);
  const [mine, claimed] = await Promise.all([myClaim(userId, profileId), isClaimed(profileId)]);
  const numbers = mine?.status === "verified" ? await makerNumbers(profileId, now) : null;
  return view(profileId, mine, claimed, numbers);
}

/** Gives the person their line for this page, keeping the one they already have. Null when the page cannot be claimed. */
export async function startClaim(userId: string, profileId: LaunchProfileId, now: Date = new Date()): Promise<CatalogClaimView | null> {
  const repo = claimRepo(profileId);
  if (!repo) return null;
  if (!(await myClaim(userId, profileId))) {
    const { error } = await db().from("hivra_catalog_claims").insert({
      profile_id: profileId,
      user_id: userId,
      repo,
      token: randomBytes(16).toString("hex"),
    });
    // 23505: the same person started the claim twice at once; the first row stands.
    if (error && error.code !== "23505") throw new Error("Could not start the claim.");
  }
  return readClaimView(userId, profileId, now);
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, PROOF_MAX_BYTES);
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < PROOF_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  void reader.cancel().catch(() => undefined);
  return text;
}

async function readProof(repo: string): Promise<{ text: string } | { missing: "file_missing" | "unreachable" }> {
  let response: Response;
  try {
    // HEAD is the repository's default branch. A redirect is refused, so the
    // answer always comes from the repository the catalog names.
    response = await fetch(`${PROOF_HOST}/${repo}/HEAD/${CLAIM_FILE_PATH}`, {
      headers: { Accept: "text/plain" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    });
  } catch {
    return { missing: "unreachable" };
  }
  if (response.status === 404) return { missing: "file_missing" };
  if (!response.ok) return { missing: "unreachable" };
  try {
    return { text: await readBody(response) };
  } catch {
    return { missing: "unreachable" };
  }
}

/**
 * Looks for the person's line in the maker's repository and records what was
 * found. Null when they have no claim on this page to check.
 */
export async function checkClaim(userId: string, profileId: LaunchProfileId, now: Date = new Date()): Promise<CatalogClaimView | null> {
  const repo = claimRepo(profileId);
  if (!repo) return null;
  const mine = await myClaim(userId, profileId);
  if (!mine) return null;
  if (mine.status !== "verified") {
    const proof = await readProof(repo);
    const result: ClaimCheckResult = "missing" in proof
      ? proof.missing
      : proofHasLine(proof.text, mine.token) ? "verified" : "line_missing";
    const checkedAt = now.toISOString();
    const { error } = await db()
      .from("hivra_catalog_claims")
      .update({
        repo,
        check_result: result,
        checked_at: checkedAt,
        ...(result === "verified" ? { status: "verified", verified_at: checkedAt } : {}),
      })
      .eq("id", mine.id);
    if (error) throw new Error("Could not record the check.");
  }
  return readClaimView(userId, profileId, now);
}

/** Agent types by how many people used each in the last 30 days, most first. A type nobody used is left out. */
export function orderTypesByUse(rows: readonly Pick<UseRow, "agent_type" | "people" | "active_hours">[]): string[] {
  return rows
    .filter(row => count(row.people) > 0)
    .sort((a, b) => count(b.people) - count(a.people)
      || count(b.active_hours) - count(a.active_hours)
      || a.agent_type.localeCompare(b.agent_type))
    .map(row => row.agent_type);
}

let cachedOrder: { at: number; order: string[] } | null = null;

/** The catalog's order by use. Read at most once every ten minutes per server. */
export async function readCatalogOrder(now: Date = new Date()): Promise<string[]> {
  if (cachedOrder && now.getTime() - cachedOrder.at < ORDER_TTL_MS) return cachedOrder.order;
  const order = orderTypesByUse(await readUseByType(now));
  cachedOrder = { at: now.getTime(), order };
  return order;
}

/** For tests: forget the stored order. */
export function resetCatalogOrderCache(): void {
  cachedOrder = null;
}
