import {
  gaClientIdFromCookie,
  gaSessionCookieName,
  gaSessionIdFromCookie,
  sendGaMeasurementProtocolEvent,
} from "../ga-measurement-protocol";

describe("GA cookie parsing", () => {
  it("reads the client id from the _ga cookie", () => {
    expect(gaClientIdFromCookie("GA1.1.1234567890.1731830000")).toBe("1234567890.1731830000");
    expect(gaClientIdFromCookie("GA1.2.987.654")).toBe("987.654");
  });

  it("refuses anything that is not a GA client cookie", () => {
    for (const value of [undefined, null, "", "GA1.1.abc.123", "1234.5678", "GA1.1.1000.2000.3000", "GA1.1.1234567890.1731830000;x=1"]) {
      expect(gaClientIdFromCookie(value)).toBeNull();
    }
  });

  it("names the session cookie after the measurement id", () => {
    expect(gaSessionCookieName("G-ML3NFRHMYF")).toBe("_ga_ML3NFRHMYF");
  });

  it("reads the session id from both session cookie formats", () => {
    expect(gaSessionIdFromCookie("GS1.1.1731830000.3.1.1731830100.0.0.0")).toBe("1731830000");
    expect(gaSessionIdFromCookie("GS2.1.s1731830000$o3$g1$t1731830100$j0$l0$h0")).toBe("1731830000");
    expect(gaSessionIdFromCookie("GS2.1.s1731830000")).toBe("1731830000");
  });

  it("returns no session id for an unknown format", () => {
    for (const value of [undefined, "", "GS3.1.s1$o1", "GS2.1.x1731830000$o3", "GS1.1.abc.3"]) {
      expect(gaSessionIdFromCookie(value)).toBeNull();
    }
  });
});

describe("sendGaMeasurementProtocolEvent", () => {
  it("posts one event with the client id, session id and engagement time", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await sendGaMeasurementProtocolEvent({
      measurementId: "G-TEST",
      apiSecret: "test-mp-value",
      clientId: "123.456",
      sessionId: "1731830000",
      name: "sign_up",
      params: { method: "google" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.google-analytics.com/mp/collect");
    expect(parsed.searchParams.get("measurement_id")).toBe("G-TEST");
    expect(parsed.searchParams.get("api_secret")).toBe("test-mp-value");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "123.456",
      non_personalized_ads: true,
      events: [{ name: "sign_up", params: { method: "google", session_id: "1731830000", engagement_time_msec: 1 } }],
    });
  });

  it("leaves the session id out when there is none", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    await sendGaMeasurementProtocolEvent({
      measurementId: "G-TEST",
      apiSecret: "test-mp-value",
      clientId: "123.456",
      name: "sign_up",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).events[0].params).toEqual({ engagement_time_msec: 1 });
  });

  it("reports a refused request and a network failure without throwing", async () => {
    const refused = jest.fn().mockResolvedValue({ ok: false, status: 400 });
    await expect(
      sendGaMeasurementProtocolEvent({ measurementId: "G-TEST", apiSecret: "x", clientId: "1.2", name: "sign_up", fetchImpl: refused as unknown as typeof fetch })
    ).resolves.toEqual({ ok: false, status: 400 });

    const failed = jest.fn().mockRejectedValue(new Error("offline"));
    await expect(
      sendGaMeasurementProtocolEvent({ measurementId: "G-TEST", apiSecret: "x", clientId: "1.2", name: "sign_up", fetchImpl: failed as unknown as typeof fetch })
    ).resolves.toEqual({ ok: false, error: "offline" });
  });
});
