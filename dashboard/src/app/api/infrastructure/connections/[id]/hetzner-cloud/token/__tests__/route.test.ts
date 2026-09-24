import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { POST } from "../route";
import {
  replaceHetznerCloudToken,
  HetznerCloudTokenCheckError,
  HetznerCloudTokenReplaceError,
  HetznerCloudConnectionError,
} from "@/lib/infrastructure/hetzner-cloud";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/infrastructure/hetzner-cloud", () => ({
  ...jest.requireActual("@/lib/infrastructure/hetzner-cloud"),
  replaceHetznerCloudToken: jest.fn(),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
  RATE_LIMIT_PRESETS: { secretWrite: { limit: 20, windowMs: 60_000 } },
}));

const connection = "11111111-1111-4111-8111-111111111111";
const token = "replacement-project-token-value";
const context = { params: Promise.resolve({ id: connection }) };
const url = `https://hivra.test/api/infrastructure/connections/${connection}/hetzner-cloud/token`;
const request = (body: unknown = { apiToken: token }) => new NextRequest(url, {
  method: "POST",
  headers: { origin: "https://hivra.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "owner" });
  (replaceHetznerCloudToken as jest.Mock).mockResolvedValue({
    connection: { id: connection }, inventory: [], writeCheck: { strayKeyName: null }, projectCheck: "confirmed",
  });
});

it("replaces the token for the authenticated owner and route connection only", async () => {
  const response = await POST(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(replaceHetznerCloudToken).toHaveBeenCalledWith({ userId: "owner", connectionId: connection, apiToken: token });
  expect(JSON.stringify(await response.json())).not.toContain(token);
});

it.each(["auth", "origin", "type", "extra", "empty", "oversized", "connection"])("rejects %s before any provider call", async (kind) => {
  let req = request();
  let ctx = context;
  if (kind === "auth") (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  if (kind === "origin") req.headers.set("origin", "https://foreign.test");
  if (kind === "type") req.headers.set("content-type", "text/plain");
  if (kind === "extra") req = request({ apiToken: token, connectionId: "other" });
  if (kind === "empty") req = request({ apiToken: "" });
  if (kind === "oversized") req = request({ apiToken: "x".repeat(5_000) });
  if (kind === "connection") ctx = { params: Promise.resolve({ id: "not-a-uuid" }) };
  expect((await POST(req, ctx)).status).toBeGreaterThanOrEqual(400);
  expect(replaceHetznerCloudToken).not.toHaveBeenCalled();
});

it.each([
  [new HetznerCloudTokenCheckError("token_read_only"), 422, "token_read_only", /read-only/],
  [new HetznerCloudTokenCheckError("token_project_mismatch"), 422, "token_project_mismatch", /different Hetzner project/],
  [new HetznerCloudConnectionError("invalid_credentials"), 422, "invalid_credentials", /rejected this token/],
  [new HetznerCloudTokenReplaceError("token_in_use"), 409, "token_in_use", /removal or setup step.*Nothing was replaced/],
  [new HetznerCloudTokenReplaceError("server_request_in_progress"), 409, "server_request_in_progress", /creating a server in this project right now/],
  [new InfrastructureConnectionStoreError("conflict"), 409, "connection_changed", /Nothing was replaced/],
])("maps %s to a fixable response", async (error, status, code, message) => {
  (replaceHetznerCloudToken as jest.Mock).mockRejectedValueOnce(error);
  const response = await POST(request(), context);
  const body = await response.json();
  expect(response.status).toBe(status);
  expect(body.code).toBe(code);
  expect(body.error).toMatch(message);
});

it("says the token was saved when the swap happened but couldn't be confirmed", async () => {
  (replaceHetznerCloudToken as jest.Mock).mockRejectedValueOnce(new HetznerCloudTokenReplaceError("replaced_unconfirmed"));
  const response = await POST(request(), context);
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(body.code).toBe("replaced_unconfirmed");
  expect(body.error).toMatch(/Hivra saved your new token/);
  expect(body.error).not.toMatch(/Nothing was replaced/);
});
