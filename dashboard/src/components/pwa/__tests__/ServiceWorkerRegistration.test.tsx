/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import { ServiceWorkerRegistration } from "../ServiceWorkerRegistration";

// Guards the regression behind canary#316: the offline-shell service worker must
// register itself from a layout that covers PUBLIC routes (it now mounts in the
// root layout). These cover the component's registration contract directly.
describe("ServiceWorkerRegistration", () => {
  const originalServiceWorker = Object.getOwnPropertyDescriptor(
    window.navigator,
    "serviceWorker"
  );
  const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");

  function stubServiceWorker(register: jest.Mock) {
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
  }

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(window.navigator, "serviceWorker", originalServiceWorker);
    } else {
      delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
    }
    if (originalSecureContext) {
      Object.defineProperty(window, "isSecureContext", originalSecureContext);
    }
    jest.restoreAllMocks();
  });

  it("registers /sw.js at the root scope on a secure context", () => {
    const register = jest.fn().mockResolvedValue(undefined);
    stubServiceWorker(register);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    render(<ServiceWorkerRegistration />);

    expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("registers on localhost even when the context is not secure", () => {
    const register = jest.fn().mockResolvedValue(undefined);
    stubServiceWorker(register);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    // jsdom serves from http://localhost/, so the localhost allowance applies.

    render(<ServiceWorkerRegistration />);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the browser has no service worker support", () => {
    // jsdom does not implement navigator.serviceWorker, so leaving it unstubbed
    // exercises the unsupported-browser path.
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;

    expect(() => render(<ServiceWorkerRegistration />)).not.toThrow();
  });

  it("swallows registration failures so the app stays usable", () => {
    const register = jest.fn().mockRejectedValue(new Error("registration blocked"));
    stubServiceWorker(register);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    expect(() => render(<ServiceWorkerRegistration />)).not.toThrow();
    expect(register).toHaveBeenCalled();
  });
});
