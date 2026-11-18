/** @jest-environment jsdom */
import { sendGaEvent, sendGaSignUpFromServer } from "../ga-client";
import { writeStoredConsent } from "@/lib/consent/cookie-consent";

type WindowWithGtag = Window & { gtag?: jest.Mock };

afterEach(() => {
  delete (window as WindowWithGtag).gtag;
  jest.useRealTimers();
});

describe("sendGaEvent", () => {
  it("sends immediately when GA is already initialised", () => {
    const gtag = jest.fn();
    (window as WindowWithGtag).gtag = gtag;
    sendGaEvent("sign_up", { method: "clerk" });
    expect(gtag).toHaveBeenCalledWith("event", "sign_up", { method: "clerk" });
  });

  it("waits for the deferred GA script instead of dropping an early event", () => {
    jest.useFakeTimers();
    sendGaEvent("sign_up", { method: "clerk" });
    const gtag = jest.fn();
    jest.advanceTimersByTime(2_000);
    (window as WindowWithGtag).gtag = gtag;
    jest.advanceTimersByTime(250);
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "sign_up", { method: "clerk" });
    jest.advanceTimersByTime(5_000);
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly if GA never loads", () => {
    jest.useFakeTimers();
    sendGaEvent("sign_up");
    jest.advanceTimersByTime(10_500);
    const gtag = jest.fn();
    (window as WindowWithGtag).gtag = gtag;
    jest.advanceTimersByTime(5_000);
    expect(gtag).not.toHaveBeenCalled();
  });
});

describe("sendGaSignUpFromServer", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
    document.cookie = "hh_cookie_consent=; Max-Age=0; Path=/";
  });

  it("asks the server to send the sign-up when analytics was accepted", () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    writeStoredConsent("accepted");
    sendGaSignUpFromServer();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/telemetry/ga-sign-up",
      expect.objectContaining({ method: "POST", credentials: "same-origin", keepalive: true, body: "{}" })
    );
  });

  it("does nothing without consent", () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    sendGaSignUpFromServer();
    writeStoredConsent("rejected");
    sendGaSignUpFromServer();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
