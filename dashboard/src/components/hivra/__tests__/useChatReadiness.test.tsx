/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatReadiness } from "../useChatReadiness";
import { inspectChatReadiness } from "@/lib/hivra/chat-readiness";
jest.mock("@/lib/hivra/chat-readiness", () => ({ inspectChatReadiness: jest.fn() }));
const inspect = jest.mocked(inspectChatReadiness);
beforeEach(() => inspect.mockReset());

it("discards cross-agent replies and rechecks after model changes and power transitions", async () => {
  let first!: (value: "native_connected") => void;
  inspect.mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue("provider_configured");
  const { result, rerender } = renderHook(({ id, revision, status }) => useChatReadiness(id, status, "https://box.test", "codex", "fixture", revision),
    { initialProps: { id: "a", revision: 0, status: "running" } });
  expect(result.current).toBeNull();
  rerender({ id: "b", revision: 0, status: "running" });
  await waitFor(() => expect(result.current).toBe("provider_configured"));
  await act(async () => { first("native_connected"); });
  expect(result.current).toBe("provider_configured");
  inspect.mockResolvedValue("sign_in_required");
  rerender({ id: "b", revision: 1, status: "running" });
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toBe("sign_in_required"));
  rerender({ id: "b", revision: 1, status: "stopped" });
  expect(result.current).toBeNull();
  rerender({ id: "b", revision: 1, status: "running" });
  expect(result.current).toBeNull();
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(4));
});
