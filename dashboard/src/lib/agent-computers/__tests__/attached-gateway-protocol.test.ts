/** @jest-environment node */
// Whether a computer's gateway serves attached agents (design 5.4, 5.8): a
// computer made before release 2026.09.24.3 answers its metadata without
// attachedAgents and is refused at the gate, before any download.
jest.mock("server-only", () => ({}));

import { ATTACHED_AGENTS_PROTOCOL, readAttachedGatewayProtocol } from "../attached-gateway-protocol";

const meta = (body: unknown, status = 200) => jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const COMPUTER_META = { agentKind: "claude", surfaceAuth: "post-cookie-v1", resourceKind: "computer", chatAvailable: false };

it("reads a gateway from 2026.09.24.3 on as current, and one from before it as needing Update & restart", async () => {
  const current = meta({ ...COMPUTER_META, attachedAgents: ATTACHED_AGENTS_PROTOCOL });
  expect(await readAttachedGatewayProtocol("https://desk.example.test/", current)).toBe("current");
  expect(current).toHaveBeenCalledWith("https://desk.example.test/api/meta", expect.objectContaining({
    method: "GET", redirect: "manual", credentials: "omit" }));
  expect(current.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  expect(await readAttachedGatewayProtocol("https://desk.example.test", meta(COMPUTER_META))).toBe("update_required");
  expect(await readAttachedGatewayProtocol("https://desk.example.test", meta({ ...COMPUTER_META, attachedAgents: "hivra-attached-agent-v0" })))
    .toBe("update_required");
});

it("reads no answer as unavailable, never as a refusal, and asks no gateway it should not reach", async () => {
  for (const fetcher of [meta({}, 502), meta({}, 302), jest.fn().mockRejectedValue(new Error("offline")),
    jest.fn().mockResolvedValue(new Response("not json", { status: 200 })), meta([1, 2])]) {
    expect(await readAttachedGatewayProtocol("https://desk.example.test", fetcher)).toBe("unavailable");
  }
  const unused = jest.fn();
  for (const url of [null, "", "http://desk.example.test", "https://user:pass@desk.example.test", "not a url", "https://127.0.0.1"]) {
    expect(await readAttachedGatewayProtocol(url, unused)).toBe("unavailable");
  }
  expect(unused).not.toHaveBeenCalled();
});

it("stops reading an oversized answer", async () => {
  const huge = JSON.stringify({ ...COMPUTER_META, attachedAgents: ATTACHED_AGENTS_PROTOCOL, padding: "x".repeat(20_000) });
  expect(await readAttachedGatewayProtocol("https://desk.example.test", jest.fn().mockResolvedValue(new Response(huge, { status: 200 }))))
    .toBe("unavailable");
});
