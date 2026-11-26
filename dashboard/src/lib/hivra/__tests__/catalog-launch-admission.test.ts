import { offeredAgentTiles } from "@/components/launch/launch-tiles";
import { canCertifyCatalog } from "../catalog-certifier-access";
import { getCatalogAppManifest, UNIVERSAL_CATALOG_IDS } from "../catalog-manifests";
import { hasCurrentCatalogCertification } from "../catalog-manifests/certification";
import { launchHivraAgentForUser } from "../launch-agent";

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock("@/lib/logger", () => jest.requireActual("@/test-utils").createLoggerMock());

const OWNER = "user_CertifierFixture";
const CANARY = {
  HIVRA_CATALOG_CERTIFIER_OWNER_ID: OWNER,
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary",
  VERCEL_GIT_REPO_OWNER: "ashneil12",
  VERCEL_GIT_REPO_SLUG: "hivra",
};

afterEach(() => jest.restoreAllMocks());

it("matches the exact manifest hash and never grants another revision or app", () => {
  const certified = getCatalogAppManifest("it-tools")!;
  expect(hasCurrentCatalogCertification(certified)).toBe(true);
  expect(hasCurrentCatalogCertification({ ...certified, description: "Changed revision" })).toBe(false);
  expect(hasCurrentCatalogCertification(getCatalogAppManifest("dufs")!)).toBe(false);
});

it("offers certified apps only to customers and preserves the serial certifier's chooser", () => {
  jest.replaceProperty(process, "env", { ...process.env, NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG: "1" });
  const customer = offeredAgentTiles({ selfHosted: false }).map((tile) => tile.id);
  expect(customer).toContain("it-tools");
  expect(customer).not.toContain("dufs");
  expect(offeredAgentTiles({ selfHosted: false, catalogCertifier: true }).map((tile) => tile.id))
    .toEqual(expect.arrayContaining([...UNIVERSAL_CATALOG_IDS]));
  expect(offeredAgentTiles({ selfHosted: true, catalogCertifier: true }).map((tile) => tile.id)).not.toContain("dufs");
});

it("requires both exact Canary metadata and an authenticated, configured owner", () => {
  expect(canCertifyCatalog(OWNER, { ...process.env, ...CANARY })).toBe(true);
  expect(canCertifyCatalog(null, { ...process.env, ...CANARY })).toBe(false);
  expect(canCertifyCatalog("user_Other", { ...process.env, ...CANARY })).toBe(false);
  expect(canCertifyCatalog(OWNER, { ...process.env, ...CANARY, VERCEL_PROJECT_PRODUCTION_URL: "hivra.cloud" })).toBe(false);
  expect(canCertifyCatalog(OWNER, { ...process.env, ...CANARY, VERCEL_GIT_COMMIT_REF: "main" })).toBe(false);
  expect(canCertifyCatalog(OWNER, { ...process.env, ...CANARY, VERCEL_ENV: "preview" })).toBe(false);
  expect(canCertifyCatalog(OWNER, { ...process.env, ...CANARY, HIVRA_CATALOG_CERTIFIER_OWNER_ID: undefined })).toBe(false);
});

it("rejects a direct launch of an uncertified app before querying persistence, even when the request claims certification", async () => {
  jest.replaceProperty(process, "env", { ...process.env, ...CANARY, NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG: "1" });
  const response = await launchHivraAgentForUser("user_Other", {
    type: "dufs", deployment: { mode: "hivra-managed" }, catalogCertifier: true,
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("isn't certified");
  expect(mockFrom).not.toHaveBeenCalled();
});
