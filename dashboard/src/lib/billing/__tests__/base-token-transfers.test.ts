/** @jest-environment node */
import { createBaseChainReader, type JsonRpcFetch } from "@/lib/billing/base-token-transfers";

const noDelay = async () => {};

it("times out a stalled RPC request and retries it instead of hanging the run", async () => {
  let calls = 0;
  const fetchImpl: JsonRpcFetch = (_url, init) => {
    calls += 1;
    if (calls === 1) {
      // Accepts the request, never answers: only the abort signal ends it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }) });
  };
  const chain = createBaseChainReader({ fetchImpl, requestTimeoutMs: 20, rpcOptions: { sleepImpl: noDelay } });

  await expect(chain.latestBlock()).resolves.toBe(16);
  expect(calls).toBe(2);
});
