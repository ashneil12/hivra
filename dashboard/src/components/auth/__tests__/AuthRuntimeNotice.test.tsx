/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CLERK_CHUNK_RETRY_STORAGE_KEY } from "@/lib/clerk-runtime-errors";

import { AuthRuntimeNotice } from "../AuthRuntimeNotice";

describe("AuthRuntimeNotice", () => {
  // The asset-load handler reloads ONCE per session before falling back to the
  // recovery notice (shouldRetryClerkChunkLoad). jsdom exposes a usable
  // sessionStorage at the default http://localhost origin, so a fresh
  // ChunkLoadError takes the reload path and renders NO notice — which is why
  // these helpers gate the retry flag explicitly instead of relying on test
  // ordering. (Without this, the notice tests only passed in environments where
  // jsdom denied sessionStorage, e.g. an opaque origin — making the suite
  // environment-dependent and red on canary CI.)
  const clearChunkRetryFlag = () => {
    try {
      window.sessionStorage.removeItem(CLERK_CHUNK_RETRY_STORAGE_KEY);
    } catch {
      // No usable storage — nothing to clear.
    }
  };

  // Mirrors getChunkRetryStore in the component: whether this jsdom exposes a
  // writable sessionStorage. The reload branch only engages when it does.
  const chunkRetryStorageAvailable = () => {
    try {
      const probeKey = "hermes:clerk-chunk-retry-probe";
      window.sessionStorage.setItem(probeKey, "1");
      window.sessionStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  };

  // Mark the one-shot reload as already spent so the handler skips reload and
  // renders the notice deterministically — mirroring the real post-retry state
  // a user lands in. Robust to storage being unavailable: shouldRetryClerkChunkLoad
  // already declines (and the notice renders) when there is no usable store.
  const markChunkReloadSpent = () => {
    try {
      window.sessionStorage.setItem(CLERK_CHUNK_RETRY_STORAGE_KEY, "1");
    } catch {
      // No usable storage — the handler already falls back to the notice.
    }
  };

  const mountClerkWidget = async () => {
    await act(async () => {
      const clerkRoot = document.createElement("div");
      clerkRoot.setAttribute("data-clerk-component", "SignIn");
      document.body.appendChild(clerkRoot);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    document
      .querySelectorAll('[data-clerk-component="SignIn"]')
      .forEach((element) => element.remove());
    jest.useRealTimers();
    // sessionStorage persists across tests in the same jsdom — reset the
    // one-shot reload flag so each test controls the reload-vs-notice branch
    // itself rather than inheriting a sibling test's leftover state.
    clearChunkRetryFlag();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("shows a recovery notice for Clerk session touch network failures", async () => {
    render(<AuthRuntimeNotice />);

    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error(
      'ClerkJS: Network error at "https://clerk.hermesos.cloud/v1/client/sessions/sess_123/touch" - TypeError: Load failed. Please try again.'
    );

    act(() => {
      window.dispatchEvent(event);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /temporarily failed to reach our sign-in service/i
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss notice/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores unrelated runtime errors", () => {
    render(<AuthRuntimeNotice />);

    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("Something else failed");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a recovery notice for Clerk asset download failures", async () => {
    // The first asset failure spends the one-shot reload; the notice is the
    // fallback once that retry is exhausted (or unavailable). Seed the spent
    // flag so we assert the notice without depending on a real page reload.
    markChunkReloadSpent();

    render(<AuthRuntimeNotice />);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ChunkLoadError: Loading chunk 26 failed.",
          filename: "https://clerk.hermesos.cloud/npm/@clerk/ui@1.6.3/chunks/26.js",
        })
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /failed to download all required files/i
    );
  });

  it("retries once via reload before falling back to the asset notice", () => {
    // Fresh session (beforeEach cleared the flag): the first Clerk asset
    // failure should attempt the one-shot reload and record it, rather than
    // showing the notice. jsdom can't navigate, so reload is a no-op here — we
    // assert the *decision* (no notice yet + retry recorded). Suppress the
    // expected jsdom "Not implemented: navigation" console noise.
    if (!chunkRetryStorageAvailable()) {
      // Without usable storage the handler can't guarantee a one-shot guard, so
      // it skips reload and shows the notice immediately — nothing to assert here.
      return;
    }

    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    render(<AuthRuntimeNotice />);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ChunkLoadError: Loading chunk 26 failed.",
          filename: "https://clerk.hermesos.cloud/npm/@clerk/ui@1.6.3/chunks/26.js",
        })
      );
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(CLERK_CHUNK_RETRY_STORAGE_KEY)).toBe("1");

    consoleError.mockRestore();
  });

  it("ignores chunk-load failures that do not come from Clerk assets", () => {
    render(<AuthRuntimeNotice />);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ChunkLoadError: Loading chunk 99 failed.",
          filename: "https://cdn.example.com/assets/99.js",
        })
      );
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores chunk-load failures that only mention the local clerk-runtime-errors helper", () => {
    render(<AuthRuntimeNotice />);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ChunkLoadError: Loading chunk 26 failed.",
          filename: "http://localhost/_next/static/chunks/app/clerk-runtime-errors.js",
        })
      );
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the asset recovery notice once the Clerk widget mounts", async () => {
    // Spend the one-shot reload so the asset failure renders the notice (the
    // state this test then clears) rather than reloading. Previously this only
    // passed because the prior asset test happened to set the flag first.
    markChunkReloadSpent();

    render(<AuthRuntimeNotice />);

    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ChunkLoadError: Loading chunk 26 failed.",
          filename: "https://clerk.hermesos.cloud/npm/@clerk/ui@1.6.3/chunks/26.js",
        })
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /failed to download all required files/i
    );

    await mountClerkWidget();

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    document
      .querySelectorAll('[data-clerk-component="SignIn"]')
      .forEach((element) => element.remove());
  });

  it("shows a recovery notice when the Clerk widget never mounts", () => {
    jest.useFakeTimers();

    render(<AuthRuntimeNotice />);

    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /sign-in form did not finish loading/i
    );

    jest.useRealTimers();
  });

  it("does not show the missing-widget notice when Clerk mounts in time", async () => {
    jest.useFakeTimers();

    render(<AuthRuntimeNotice />);

    await act(async () => {
      const clerkRoot = document.createElement("div");
      clerkRoot.setAttribute("data-clerk-component", "SignIn");
      document.body.appendChild(clerkRoot);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    document
      .querySelectorAll('[data-clerk-component="SignIn"]')
      .forEach((element) => element.remove());

    jest.useRealTimers();
  });
});
