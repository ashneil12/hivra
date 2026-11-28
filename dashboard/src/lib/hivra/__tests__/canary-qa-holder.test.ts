import { canaryQaHolderDeadline, isCanaryQaHolderSeatActive } from "../canary-qa-holder";
import { isStartBlockedForLapse } from "../lapse-gate";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

const mockSettings = jest.fn();
const mockFrom = jest.fn(() => ({
  select: () => ({ eq: () => ({ maybeSingle: () => mockSettings() }) }),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => mockFrom() } }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn() } }));

jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
  hasTokenTierInGrace: jest.fn(),
}));

const now = Date.parse("2026-01-01T09:00:00.000Z");
const expiry = "2026-01-01T10:00:00.000Z";
const fixtureUser = "user_fixture1";
const env = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary",
  VERCEL_GIT_REPO_OWNER: "ashneil12",
  VERCEL_GIT_REPO_SLUG: "hivra",
  HIVRA_CANARY_QA_HOLDER_ENABLED: "true",
  HIVRA_CANARY_QA_HOLDER_USER_ID: fixtureUser,
  HIVRA_CANARY_QA_HOLDER_EXPIRES_AT: expiry,
};

beforeEach(() => mockSettings.mockResolvedValue({ data: null, error: null }));

it("grants the exact standing owner from env only when no runtime row exists", async () => {
  await expect(canaryQaHolderDeadline(fixtureUser, now, env)).resolves.toBe(expiry);
  await expect(canaryQaHolderDeadline("user_fixture2", now, env)).resolves.toBeNull();
  await expect(canaryQaHolderDeadline(fixtureUser, now, {})).resolves.toBeNull();
  expect(mockFrom).toHaveBeenCalledTimes(2);
});

it.each([
  ["VERCEL", undefined],
  ["VERCEL_ENV", "preview"],
  ["VERCEL_PROJECT_PRODUCTION_URL", "hivra.cloud"],
  ["VERCEL_PROJECT_PRODUCTION_URL", "hermesos-canary.vercel.app"],
  ["VERCEL_GIT_COMMIT_REF", "main"],
  ["VERCEL_GIT_COMMIT_REF", undefined],
  ["VERCEL_GIT_REPO_OWNER", "fork"],
  ["VERCEL_GIT_REPO_SLUG", "another"],
  ["HIVRA_CANARY_QA_HOLDER_ENABLED", undefined],
  ["HIVRA_CANARY_QA_HOLDER_ENABLED", "1"],
  ["HIVRA_CANARY_QA_HOLDER_USER_ID", undefined],
  ["HIVRA_CANARY_QA_HOLDER_USER_ID", "user_fixture1,user_fixture2"],
  ["HIVRA_CANARY_QA_HOLDER_EXPIRES_AT", "2026-01-01T08:59:59.999Z"],
  ["HIVRA_CANARY_QA_HOLDER_EXPIRES_AT", "2026-01-02T09:00:00.001Z"],
  ["HIVRA_CANARY_QA_HOLDER_EXPIRES_AT", "2026-01-01T09:00:00.000Z"],
  ["HIVRA_CANARY_QA_HOLDER_EXPIRES_AT", "2026-02-31T10:00:00.000Z"],
])("fails closed for %s=%s", async (key, value) => {
  await expect(canaryQaHolderDeadline(fixtureUser, now, {
    ...env, [key]: value, NEXT_PUBLIC_APP_URL: "https://canary.hermesos.cloud",
  })).resolves.toBeNull();
});

it("lets an exact runtime row take precedence over env, normalizing the database timestamp", async () => {
  mockSettings.mockResolvedValue({ data: { enabled: true, owner_id: "user_fixture2",
    expires_at: "2026-01-01T09:30:00+00:00" }, error: null });
  await expect(canaryQaHolderDeadline("user_fixture2", now, env)).resolves.toBe("2026-01-01T09:30:00.000Z");
  await expect(canaryQaHolderDeadline(fixtureUser, now, env)).resolves.toBeNull();
  mockFrom.mockClear();
  await expect(canaryQaHolderDeadline("user_fixture2", now, { ...env, VERCEL_GIT_COMMIT_REF: "main" }))
    .resolves.toBeNull();
  expect(mockFrom).not.toHaveBeenCalled();
});

it.each([
  { enabled: false, expires_at: expiry },
  { enabled: true, expires_at: "2026-01-01T08:59:59Z" },
  { enabled: true, expires_at: "2026-01-02T09:00:01Z" },
])("does not fall back to env when a runtime row is disabled or out of window", async (settings) => {
  mockSettings.mockResolvedValue({ data: { owner_id: fixtureUser, ...settings }, error: null });
  await expect(canaryQaHolderDeadline(fixtureUser, now, env)).resolves.toBeNull();
});

it("keeps the allowance on the exact marked seat and preserves cleanup after revocation", async () => {
  jest.useFakeTimers().setSystemTime(now);
  jest.replaceProperty(process, "env", { ...env, NODE_ENV: "test" });
  const seat = { user_id: fixtureUser, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
    canary_qa_holder_expires_at: expiry };
  try {
    await expect(isStartBlockedForLapse(seat, "start")).resolves.toBe(false);
    await expect(isStartBlockedForLapse(seat, "resize")).resolves.toBe(true);
    expect(resolveEffectiveSubscription).not.toHaveBeenCalled();
    await expect(isCanaryQaHolderSeatActive({ user_id: fixtureUser }, now)).resolves.toBe(false);
    mockSettings.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(isStartBlockedForLapse(seat, "start")).resolves.toBe(true);
    mockSettings.mockResolvedValue({ data: null, error: null });
    delete process.env.HIVRA_CANARY_QA_HOLDER_ENABLED;
    await expect(isStartBlockedForLapse(seat, "start")).resolves.toBe(true);
    await expect(isStartBlockedForLapse(seat, "stop")).resolves.toBe(false);
    await expect(isStartBlockedForLapse(seat, "delete")).resolves.toBe(false);
    process.env.HIVRA_CANARY_QA_HOLDER_ENABLED = "true";
    process.env.HIVRA_CANARY_QA_HOLDER_EXPIRES_AT = "2026-01-01T11:00:00.000Z";
    jest.setSystemTime(Date.parse(expiry));
    await expect(isStartBlockedForLapse(seat, "restart")).resolves.toBe(true);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});
