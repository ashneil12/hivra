/**
 * The four public documents that carry token text, served by country.
 *
 * LITEPAPER.md, WHITEPAPER.md, TOKENOMICS.md and the litepaper page are NOT
 * files in public/. A static file is found by Vercel after it decodes the path,
 * while a path rule matches the raw text, so a viewer in a listed country could
 * spell one character of the address as %XX and get the full file. Here the
 * route handlers behind those four addresses are the only way to reach a full
 * document: Next decodes the path before it picks the route, and the handler
 * asks the same gate as every other token surface (./token-geo-gate.ts).
 *
 * - A request from a listed country gets the token-free copy cut by
 *   docs/litepaper/restrict.py.
 * - Anyone else, and a request with no country signal (self-hosted installs
 *   have no Vercel edge), gets the full document.
 * - If the copy for the variant cannot be read the answer is a 500. It never
 *   falls back to the other copy.
 *
 * scripts/stage-litepaper.mjs puts both copies under GEO_DOCUMENTS_DIRECTORY,
 * and next.config.ts carries them into each handler's serverless function
 * (outputFileTracingIncludes). Responses are never stored by a shared cache.
 */
import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { log } from "@/lib/logger";

import { resolveTokenGeoBlock, type TokenGeoOptions, type TokenGeoRequest } from "./token-geo-gate";

/** Relative to the dashboard root. Must match GEO_DOCUMENTS_DIRECTORY in scripts/stage-litepaper.mjs. */
export const GEO_DOCUMENTS_DIRECTORY = ".generated/litepaper";

/** The documents, by the file name each copy has under full/ and restricted/. */
export const TOKEN_GEO_DOCUMENTS = {
  "LITEPAPER.md": { route: "/LITEPAPER.md", contentType: "text/markdown; charset=utf-8" },
  "WHITEPAPER.md": { route: "/WHITEPAPER.md", contentType: "text/markdown; charset=utf-8" },
  "TOKENOMICS.md": { route: "/TOKENOMICS.md", contentType: "text/markdown; charset=utf-8" },
  "litepaper.html": { route: "/docs/litepaper/index.html", contentType: "text/html; charset=utf-8" },
} as const;

export type TokenGeoDocumentName = keyof typeof TOKEN_GEO_DOCUMENTS;
export type TokenGeoDocumentVariant = "full" | "restricted";

/** Different viewers get different bytes at one address, so no shared cache may keep either. */
export const TOKEN_GEO_DOCUMENT_CACHE_CONTROL = "private, no-store";

const LOG_SOURCE = "compliance/token-geo-documents";

export interface TokenGeoDocumentOptions {
  /** Test seam; passed to the gate (policy and identity seams). */
  geo?: TokenGeoOptions;
  /** Test seam; the dashboard root that holds GEO_DOCUMENTS_DIRECTORY. Defaults to process.cwd(). */
  dashboardRoot?: string;
}

function noStoreHeaders(contentType: string) {
  return { "Content-Type": contentType, "Cache-Control": TOKEN_GEO_DOCUMENT_CACHE_CONTROL };
}

/**
 * Answers a request for one of the documents. Only the request's IP country is
 * read: a document has no signed-in user, as with the static files before it.
 */
export async function serveTokenGeoDocument(
  request: TokenGeoRequest,
  name: TokenGeoDocumentName,
  options: TokenGeoDocumentOptions = {}
): Promise<Response> {
  const document = TOKEN_GEO_DOCUMENTS[name];
  const decision = await resolveTokenGeoBlock(request, null, options.geo);
  const variant: TokenGeoDocumentVariant = decision.blocked ? "restricted" : "full";
  const file = path.join(options.dashboardRoot ?? process.cwd(), GEO_DOCUMENTS_DIRECTORY, variant, name);
  try {
    return new Response(await readFile(file, "utf8"), { status: 200, headers: noStoreHeaders(document.contentType) });
  } catch (error) {
    log.error("token geo document could not be read; nothing is served", error, {
      source: LOG_SOURCE,
      route: document.route,
      failureType: "token_geo_document_unavailable",
      variant,
    });
    return new Response("This document is unavailable.\n", {
      status: 500,
      headers: noStoreHeaders("text/plain; charset=utf-8"),
    });
  }
}
