/** @jest-environment node */

import { NextRequest } from "next/server";

const mockRefresh = jest.fn();
const mockHeartbeat = jest.fn();
const mockError = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: (...args: unknown[]) => mockHeartbeat(...args) }));
jest.mock("@/lib/logger", () => ({
  log: { error: (...args: unknown[]) => mockError(...args), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("@/lib/infrastructure/gvisor-target", () => ({
  refreshManagedGvisorTarget: (...args: unknown[]) => mockRefresh(...args),
  GvisorTargetError: class extends Error {},
}));

import { GET } from "../route";

const CRON = "refresh-managed-gvisor-target";
const env = process.env;
const authority = {
  HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID: "user_test",
  HIVRA_MANAGED_GVISOR_CONNECTION_ID: "33333333-3333-4333-8333-333333333333",
  HIVRA_MANAGED_GVISOR_TARGET_ID: "44444444-4444-4444-8444-444444444444",
  HIVRA_MANAGED_GVISOR_CONNECTION_REVISION: "5",
};

function request(token = "fixture-cron") {
  return new NextRequest("https://worker.example/api/cron/" + CRON, {
    headers: { authorization: "Bearer " + token },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { NODE_ENV: "test", CRON_SECRET: "fixture-cron" };
});

afterEach(() => { process.env = env; });

it("requires cron auth and never reads target authority while disabled", async () => {
  expect((await GET(request("untrusted"))).status).toBe(401);
  expect(mockHeartbeat).not.toHaveBeenCalled();
  await expect((await GET(request())).json()).resolves.toMatchObject({ data: { refreshed: false } });
  expect(mockRefresh).not.toHaveBeenCalled();
  expect(mockHeartbeat).toHaveBeenCalledWith(CRON);
});

it("refreshes only the configured authority and stamps success after it completes", async () => {
  Object.assign(process.env, authority, { HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "1" });
  await expect((await GET(request())).json()).resolves.toMatchObject({ data: { refreshed: true } });
  expect(mockRefresh).toHaveBeenCalledWith({
    authorityUserId: "user_test", connectionId: authority.HIVRA_MANAGED_GVISOR_CONNECTION_ID,
    targetId: authority.HIVRA_MANAGED_GVISOR_TARGET_ID, connectionRevision: 5,
  });
  expect(mockRefresh.mock.invocationCallOrder[0]).toBeLessThan(mockHeartbeat.mock.invocationCallOrder[0]);
  expect(mockHeartbeat).toHaveBeenCalledWith(CRON);
});

it("records a sanitized failure instead of refreshing a heartbeat as healthy", async () => {
  Object.assign(process.env, authority, { HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED: "true" });
  mockRefresh.mockRejectedValue(new Error("private implementation detail"));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private implementation detail");
  expect(mockError).toHaveBeenCalledWith(expect.any(String), new Error("refresh_failed"), expect.any(Object));
  expect(mockHeartbeat).toHaveBeenCalledTimes(1);
  expect(mockHeartbeat).toHaveBeenCalledWith(CRON, { ok: false, detail: "refresh_failed" });
});

it("only renews QA evidence on canonical Canary with an unexpired enrollment", async () => {
  Object.assign(process.env, authority, {
    HIVRA_MANAGED_GVISOR_QA_ENROLLMENT_ENABLED: "true",
    HIVRA_MANAGED_GVISOR_QA_OWNER_ID: "user_customer",
    HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
  });
  expect((await GET(request())).status).toBe(200);
  expect(mockRefresh).not.toHaveBeenCalled();
  process.env.VERCEL_GIT_COMMIT_REF = "canary";
  expect((await GET(request())).status).toBe(200);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  process.env.HIVRA_MANAGED_GVISOR_QA_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  expect((await GET(request())).status).toBe(200);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});
