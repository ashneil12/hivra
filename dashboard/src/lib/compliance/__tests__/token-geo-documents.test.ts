/** @jest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "@/lib/logger";

import {
  GEO_DOCUMENTS_DIRECTORY,
  TOKEN_GEO_DOCUMENTS,
  TOKEN_GEO_DOCUMENT_CACHE_CONTROL,
  serveTokenGeoDocument,
  type TokenGeoDocumentName,
} from "../token-geo-documents";

jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

const GB = { policy: { blockedCountries: ["GB"] } };
const NAMES = Object.keys(TOKEN_GEO_DOCUMENTS) as TokenGeoDocumentName[];

let root: string;

function writeCopies(variant: "full" | "restricted", only: TokenGeoDocumentName[] = NAMES) {
  for (const name of only) {
    const file = path.join(root, GEO_DOCUMENTS_DIRECTORY, variant, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${variant} ${name}\n`);
  }
}

function request(country?: string) {
  return new Request("https://hivra.test/any", country === undefined ? {} : { headers: { "x-vercel-ip-country": country } });
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "hivra-geo-documents-"));
  writeCopies("full");
  writeCopies("restricted");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("token geo documents", () => {
  it.each(NAMES)("%s: a viewer in a listed country gets the token-free copy and nothing else", async (name) => {
    const response = await serveTokenGeoDocument(request("GB"), name, { geo: GB, dashboardRoot: root });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`restricted ${name}\n`);
    expect(response.headers.get("content-type")).toBe(TOKEN_GEO_DOCUMENTS[name].contentType);
  });

  it.each(NAMES)("%s: every other viewer gets the full document", async (name) => {
    for (const country of ["US", "FR", "XX", "T1", undefined]) {
      const response = await serveTokenGeoDocument(request(country), name, { geo: GB, dashboardRoot: root });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`full ${name}\n`);
    }
  });

  it("reads the country the way the gate does: any case, and with spaces around it", async () => {
    for (const country of ["gb", " GB "]) {
      const response = await serveTokenGeoDocument(request(country), "LITEPAPER.md", { geo: GB, dashboardRoot: root });
      expect(await response.text()).toBe("restricted LITEPAPER.md\n");
    }
  });

  it("serves the full document to everyone while the country list is empty", async () => {
    const response = await serveTokenGeoDocument(request("GB"), "WHITEPAPER.md", {
      geo: { policy: { blockedCountries: [] } },
      dashboardRoot: root,
    });
    expect(await response.text()).toBe("full WHITEPAPER.md\n");
  });

  it("never lets a shared cache keep either copy", async () => {
    expect(TOKEN_GEO_DOCUMENT_CACHE_CONTROL).toBe("private, no-store");
    for (const country of ["GB", "US", undefined]) {
      const response = await serveTokenGeoDocument(request(country), "TOKENOMICS.md", { geo: GB, dashboardRoot: root });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("answers 500 and never falls back to the full copy when the token-free copy is missing", async () => {
    rmSync(path.join(root, GEO_DOCUMENTS_DIRECTORY, "restricted", "LITEPAPER.md"));
    const response = await serveTokenGeoDocument(request("GB"), "LITEPAPER.md", { geo: GB, dashboardRoot: root });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("full");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("nothing is served"),
      expect.anything(),
      expect.objectContaining({ failureType: "token_geo_document_unavailable", variant: "restricted" }),
    );
  });

  it("answers 500, not the token-free copy, when the full copy is missing for an unlisted viewer", async () => {
    rmSync(path.join(root, GEO_DOCUMENTS_DIRECTORY, "full", "litepaper.html"));
    const response = await serveTokenGeoDocument(request("US"), "litepaper.html", { geo: GB, dashboardRoot: root });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("restricted");
  });

  it("names the four documents the stage script and next.config.ts know about", () => {
    expect(Object.values(TOKEN_GEO_DOCUMENTS).map(({ route }) => route).sort()).toEqual([
      "/LITEPAPER.md",
      "/TOKENOMICS.md",
      "/WHITEPAPER.md",
      "/docs/litepaper/index.html",
    ]);
  });
});
