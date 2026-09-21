import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { GET, POST } from "../route";
import { listProviderComputerSetups, advanceProviderComputerSetup } from "@/lib/infrastructure/provider-computer-setup";
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/infrastructure/provider-computer-setup", () => ({ ...jest.requireActual("@/lib/infrastructure/provider-computer-setup"), listProviderComputerSetups: jest.fn(), advanceProviderComputerSetup: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn(() => null) }));
const connection = "11111111-1111-4111-8111-111111111111", order = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: connection }) };
const input = { orderId: order, expectedConnectionRevision: 7 };
const url = `https://hivra.test/api/infrastructure/connections/${connection}/hetzner-cloud/capacity/setup`;
const request = (body: unknown = input) => new NextRequest(url, { method: "POST", headers: { origin: "https://hivra.test", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  jest.clearAllMocks(); (auth as unknown as jest.Mock).mockResolvedValue({ userId: "owner" });
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([]);
  (advanceProviderComputerSetup as jest.Mock).mockResolvedValue({ stage: "waiting_for_identity" });
});
it("reads without advancing any setup", async () => {
  const result = await GET(new NextRequest(url), context);
  expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(listProviderComputerSetups).toHaveBeenCalledWith("owner", connection);
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("passes only authenticated owner, route connection and validated request", async () => {
  expect((await POST(request(), context)).status).toBe(202);
  expect(advanceProviderComputerSetup).toHaveBeenCalledWith("owner", connection, input);
});
it.each(["auth", "origin", "metadata", "type", "extra", "oversized"])("rejects %s before advancing", async kind => {
  let req = request();
  if (kind === "auth") (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  if (kind === "origin") req.headers.set("origin", "https://foreign.test");
  if (kind === "metadata") req.headers.delete("sec-fetch-site");
  if (kind === "type") req.headers.set("content-type", "text/plain");
  if (kind === "extra") req = request({ ...input, userId: "other", serverId: "55" });
  if (kind === "oversized") req = request({ padding: "x".repeat(1500) });
  expect((await POST(req, context)).status).toBeGreaterThanOrEqual(400);
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
