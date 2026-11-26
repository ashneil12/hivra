import {
  managedGvisorLaunchAdmittedForUser,
  managedGvisorLaunchConfigured,
} from "../managed-gvisor-launch-config";

const AUTHORITY = {
  HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: "user_managed_fixture",
  HIVRA_MANAGED_GVISOR_CONNECTION_ID: "11111111-1111-4111-8111-111111111111",
  HIVRA_MANAGED_GVISOR_TARGET_ID: "22222222-2222-4222-8222-222222222222",
  HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "1",
} as const;

const CONFIGURED = {
  HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true",
  ...AUTHORITY,
} as const;

const CANONICAL_CANARY = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary",
  VERCEL_GIT_REPO_OWNER: "ashneil12",
  VERCEL_GIT_REPO_SLUG: "hivra",
} as const;

const QA_OWNER = "user_qa_owner";
const QA_EXPIRY = "2026-11-27T00:00:00.000Z";
const NOW = Date.parse("2026-11-26T00:00:00.000Z");

const QA_CONFIGURED = {
  HIVRA_MANAGED_GVISOR_QA_ENROLLMENT_ENABLED: "true",
  HIVRA_MANAGED_GVISOR_QA_OWNER_ID: QA_OWNER,
  HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: QA_EXPIRY,
  ...AUTHORITY,
  ...CANONICAL_CANARY,
} as const;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function qaEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return env({ ...QA_CONFIGURED, ...overrides });
}

it("is off by default and off when only the switch is on", () => {
  expect(managedGvisorLaunchConfigured(env())).toBe(false);
  expect(managedGvisorLaunchConfigured(env({ HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true" }))).toBe(false);
});

it("is on only when the general switch and complete server authority shape are present", () => {
  expect(managedGvisorLaunchConfigured(env(CONFIGURED))).toBe(true);
  expect(managedGvisorLaunchAdmittedForUser("user_any_paid", env(CONFIGURED), NOW)).toBe(true);
});

it("fails closed for malformed general authority configuration", () => {
  expect(managedGvisorLaunchConfigured(env({ ...CONFIGURED, HIVRA_MANAGED_GVISOR_TARGET_ID: "not-a-target" }))).toBe(false);
  expect(managedGvisorLaunchConfigured(env({ ...CONFIGURED, HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "0" }))).toBe(false);
  expect(managedGvisorLaunchAdmittedForUser("user_any_paid", env({ ...CONFIGURED, HIVRA_MANAGED_GVISOR_CONNECTION_ID: "bad" }), NOW)).toBe(false);
});

it("keeps QA enrollment off by default even when its other settings are present", () => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv({ HIVRA_MANAGED_GVISOR_QA_ENROLLMENT_ENABLED: undefined }), NOW)).toBe(false);
});

it("admits exactly the configured QA owner on canonical Git Canary with the general switch off", () => {
  expect(qaEnv().HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED).toBeUndefined();
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv(), NOW)).toBe(true);
});

it("denies other and anonymous principals before any QA billing or connector path", () => {
  expect(managedGvisorLaunchAdmittedForUser("user_other_paid", qaEnv(), NOW)).toBe(false);
  expect(managedGvisorLaunchAdmittedForUser(null, qaEnv(), NOW)).toBe(false);
  expect(managedGvisorLaunchAdmittedForUser(undefined, qaEnv(), NOW)).toBe(false);
});

it.each([
  ["missing", { HIVRA_MANAGED_GVISOR_QA_OWNER_ID: undefined }],
  ["empty", { HIVRA_MANAGED_GVISOR_QA_OWNER_ID: "" }],
  ["whitespace", { HIVRA_MANAGED_GVISOR_QA_OWNER_ID: ` ${QA_OWNER} ` }],
  ["wrong prefix", { HIVRA_MANAGED_GVISOR_QA_OWNER_ID: "qa_owner" }],
  ["multiple", { HIVRA_MANAGED_GVISOR_QA_OWNER_ID: `${QA_OWNER},user_other` }],
])("rejects a %s QA owner id", (_label, overrides) => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv(overrides), NOW)).toBe(false);
});

it.each([
  ["missing", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: undefined }],
  ["past", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: "2026-11-25T00:00:00.000Z" }],
  ["current instant", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: "2026-11-26T00:00:00.000Z" }],
  ["offset instead of UTC", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: "2026-11-27T00:00:00.000+00:00" }],
  ["noncanonical milliseconds", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: "2026-11-27T00:00:00Z" }],
  ["invalid date", { HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: "2026-02-30T00:00:00.000Z" }],
])("rejects a %s QA expiry", (_label, overrides) => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv(overrides), NOW)).toBe(false);
});

it.each([
  ["missing Vercel marker", { VERCEL: undefined }],
  ["nonproduction Vercel environment", { VERCEL_ENV: "preview" }],
  ["wrong production domain", { VERCEL_PROJECT_PRODUCTION_URL: "hivra.cloud" }],
  ["project alias instead of the canonical domain", { VERCEL_PROJECT_PRODUCTION_URL: "hermesos-canary.vercel.app" }],
  ["wrong branch", { VERCEL_GIT_COMMIT_REF: "main" }],
  ["wrong repository owner", { VERCEL_GIT_REPO_OWNER: "foreign" }],
  ["wrong repository slug", { VERCEL_GIT_REPO_SLUG: "hivra-canary" }],
])("denies QA on %s", (_label, overrides) => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv(overrides), NOW)).toBe(false);
});

it("rejects conflicting general and QA enabled modes", () => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv({ HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true" }), NOW)).toBe(false);
});

it.each([
  ["missing operator", { HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: undefined }],
  ["malformed connection", { HIVRA_MANAGED_GVISOR_CONNECTION_ID: "not-a-connection" }],
  ["malformed target", { HIVRA_MANAGED_GVISOR_TARGET_ID: "not-a-target" }],
  ["zero revision", { HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "0" }],
  ["fractional revision", { HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "1.5" }],
])("rejects a malformed QA authority tuple with %s", (_label, overrides) => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv(overrides), NOW)).toBe(false);
});

it("requires the QA operator to be distinct from the enrolled owner", () => {
  expect(managedGvisorLaunchAdmittedForUser(QA_OWNER, qaEnv({ HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: QA_OWNER }), NOW)).toBe(false);
});
