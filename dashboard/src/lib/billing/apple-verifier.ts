/**
 * Apple JWS verifier + App Store Server API client construction.
 *
 * Kept in its own module so the webhook service, the reconciler, and the
 * mobile attach route share ONE construction path — and so tests can
 * jest.mock this module instead of the Apple library itself.
 *
 * The library is loaded lazily (require at call time) mirroring the
 * stripe-webhook-service's dynamic hetzner import: the dependency is only
 * paid for on routes that actually verify Apple payloads.
 *
 * Env (deploy-time; see dashboard/README-APPLE-IAP.md):
 *   APPLE_BUNDLE_ID       bundle id baked into every verification
 *   APPLE_ENVIRONMENT     "Production" | "Sandbox" (primary verifier env)
 *   APPLE_APP_APPLE_ID    numeric App Store id — REQUIRED for Production
 *                         verification (the library throws without it)
 *   APPLE_ISSUER_ID       App Store Connect API key issuer id   (API client)
 *   APPLE_KEY_ID          App Store Connect API key id          (API client)
 *   APPLE_PRIVATE_KEY     .p8 private key PEM; literal "\n" accepted
 *                         (Vercel env convention)                (API client)
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { SignedDataVerifier, AppStoreServerAPIClient } from "@apple/app-store-server-library";

import { getAppleBundleId, getAppleEnvironment, type AppleEnvironment } from "@/lib/billing/apple-products";

// Resolved from the dashboard working directory. Certificate bytes are not
// redistributed in the source tree: the deterministic prebuild step downloads
// them directly from Apple and verifies the pinned length + SHA-256 first.
const APPLE_CERTS_DIR = join(process.cwd(), ".generated/apple-certs");

let cachedRootCertificates: Buffer[] | null = null;

/** Load every acquired DER root certificate (see apple-certs/README.md). */
function loadAppleRootCertificates(): Buffer[] {
  if (cachedRootCertificates) return cachedRootCertificates;
  const certFiles = readdirSync(APPLE_CERTS_DIR)
    .filter((name) => name.endsWith(".cer"))
    .sort();
  if (certFiles.length === 0) {
    throw new Error(
      `No Apple root certificates found in ${APPLE_CERTS_DIR}; run npm run apple:certs first`
    );
  }
  cachedRootCertificates = certFiles.map((name) =>
    readFileSync(join(APPLE_CERTS_DIR, name))
  );
  return cachedRootCertificates;
}

function libEnvironment(environment: AppleEnvironment) {
  // Lazy require so importing this module never pulls the Apple library in.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Environment } = require("@apple/app-store-server-library");
  return environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
}

function getAppAppleId(): number | undefined {
  const raw = process.env.APPLE_APP_APPLE_ID?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Build a SignedDataVerifier for the given environment (default: the
 * APPLE_ENVIRONMENT primary). Online checks stay ON — expiry/revocation are
 * part of the signature trust story for a money lane.
 */
export function getAppleSignedDataVerifier(
  environment: AppleEnvironment = getAppleEnvironment()
): SignedDataVerifier {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SignedDataVerifier: Verifier } = require("@apple/app-store-server-library");
  const appAppleId = getAppAppleId();
  if (environment === "Production" && appAppleId === undefined) {
    throw new Error(
      "APPLE_APP_APPLE_ID is required to verify Production App Store payloads"
    );
  }
  return new Verifier(
    loadAppleRootCertificates(),
    true,
    libEnvironment(environment),
    getAppleBundleId(),
    appAppleId
  );
}

/**
 * App Store Server API client (Get All Subscription Statuses etc.) for the
 * reconciler. Throws when the App Store Connect API credentials are missing —
 * callers surface that as a config error rather than silently skipping.
 */
export function getAppStoreServerAPIClient(
  environment: AppleEnvironment = getAppleEnvironment()
): AppStoreServerAPIClient {
  const issuerId = process.env.APPLE_ISSUER_ID?.trim();
  const keyId = process.env.APPLE_KEY_ID?.trim();
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!issuerId || !keyId || !privateKey) {
    throw new Error(
      "APPLE_ISSUER_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY must be configured for the App Store Server API"
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppStoreServerAPIClient: Client } = require("@apple/app-store-server-library");
  return new Client(privateKey, keyId, issuerId, getAppleBundleId(), libEnvironment(environment));
}
