import { verifyExternalCleanup } from "../hetzner-external-cleanup-client";
import { HETZNER_EXTERNAL_CLEANUP_CONFIRMATION } from "../hetzner-external-cleanup-contracts";

const connectionId = "11111111-1111-4111-8111-111111111111";
const request = {
  orderId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  serverName: "hivra-22222222222242228222",
  confirmation: HETZNER_EXTERNAL_CLEANUP_CONFIRMATION,
};
const GENERIC = "Cleanup could not be confirmed";

beforeEach(() => {
  global.fetch = jest.fn();
});

it("keeps the generic message when the error response is not JSON", async () => {
  (fetch as jest.Mock).mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
  await expect(verifyExternalCleanup(connectionId, request)).rejects.toThrow(GENERIC);
});

it("keeps the generic message when the request fails or is aborted before a response", async () => {
  (fetch as jest.Mock).mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
  await expect(verifyExternalCleanup(connectionId, request)).rejects.toThrow(GENERIC);
});

it("still shows the specific message for a known API code", async () => {
  (fetch as jest.Mock).mockResolvedValue(
    new Response(JSON.stringify({ success: false, code: "resources_remain" }), { status: 409 }),
  );
  await expect(verifyExternalCleanup(connectionId, request)).rejects.toThrow("Resources remain in this project");
});
