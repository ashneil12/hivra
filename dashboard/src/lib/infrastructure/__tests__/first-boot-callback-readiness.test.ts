import { isFirstBootCallbackReachable } from "../first-boot-callback-readiness";

const origin = "https://canary.example.test";
const json = (body: unknown, status = 401) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

it("checks the exact machine callback without credentials, redirects, or mutation payloads", async () => {
  const request = jest.fn().mockResolvedValue(json({ accepted: false }));
  expect(await isFirstBootCallbackReachable(origin, request)).toBe(true);
  expect(request).toHaveBeenCalledWith(`${origin}/api/infrastructure/first-boot/enroll`, {
    method: "POST", redirect: "manual", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal),
  });
});

it.each([
  ["deployment sign-in", () => new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api" } })],
  ["generic unauthorized page", () => new Response("Sign in", { status: 401 })],
  ["wrong successful route", () => json({ accepted: false }, 200)],
  ["server error", () => json({ accepted: false }, 503)],
  ["unexpected authorization", () => json({ accepted: true })],
  ["unrelated JSON", () => json({ error: "Unauthorized" })],
  ["extra data", () => json({ accepted: false, unrelated: true })],
  ["oversized response", () => json({ accepted: false, value: "x".repeat(300) })],
  ["invalid JSON", () => new Response("{", { status: 401, headers: { "content-type": "application/json" } })],
])("rejects %s", async (_name, response) => {
  expect(await isFirstBootCallbackReachable(origin, jest.fn().mockResolvedValue(response()))).toBe(false);
});

it("fails closed on network or timeout failures and rejects invalid origins before requesting", async () => {
  expect(await isFirstBootCallbackReachable(origin, jest.fn().mockRejectedValue(new Error("private network details")))).toBe(false);
  const request = jest.fn();
  expect(await isFirstBootCallbackReachable("https://example.test:8443", request)).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
