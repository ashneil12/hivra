/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { _resetTokenGeoAccessForTests, useTokenGeoAccess } from "../useTokenGeoAccess";

const fetchMock = jest.fn();

beforeEach(() => {
  _resetTokenGeoAccessForTests();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  jest.restoreAllMocks();
});

function answer(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({ ok, json: async () => body } as Response);
}

describe("useTokenGeoAccess", () => {
  it("is 'allowed' at once with the dormant policy and makes no request", () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
    const { result } = renderHook(() => useTokenGeoAccess());
    expect(result.current).toEqual({ status: "allowed", notice: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with a country listed, hides promotions until the server answers, then carries its notice", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    answer({ blocked: true, notice: "Token features aren't available to people in the United Kingdom." });
    const { result } = renderHook(() => useTokenGeoAccess());
    expect(result.current.status).toBe("checking");
    await waitFor(() =>
      expect(result.current).toEqual({
        status: "blocked",
        notice: "Token features aren't available to people in the United Kingdom.",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/token-geo", { cache: "no-store" });
  });

  it("is 'allowed' when the server says so, and 'unavailable' (still hidden) when it can't answer", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    answer({ blocked: false, notice: null });
    const allowed = renderHook(() => useTokenGeoAccess());
    await waitFor(() => expect(allowed.result.current.status).toBe("allowed"));

    _resetTokenGeoAccessForTests();
    answer(null, false);
    const failed = renderHook(() => useTokenGeoAccess());
    await waitFor(() => expect(failed.result.current.status).toBe("unavailable"));
  });
});
