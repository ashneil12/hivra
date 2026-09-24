/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { AuthClerkProvider } from "../AuthClerkProvider";
import { headers } from "next/headers";

const mockClerkProviderProps: Array<Record<string, unknown>> = [];

jest.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
    mockClerkProviderProps.push(props);
    return <div data-testid="clerk-provider">{children}</div>;
  },
}));

jest.mock("next/headers", () => ({
  headers: jest.fn(),
}));

describe("AuthClerkProvider", () => {
  const originalPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const originalAllowedOrigins = process.env.NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalClerkJsUrl = process.env.NEXT_PUBLIC_CLERK_JS_URL;
  const originalClerkJsVersion = process.env.NEXT_PUBLIC_CLERK_JS_VERSION;
  const originalClerkUiUrl = process.env.NEXT_PUBLIC_CLERK_UI_URL;
  const originalClerkUiVersion = process.env.NEXT_PUBLIC_CLERK_UI_VERSION;
  const originalAuthMode = process.env.HIVRA_AUTH_MODE;
  const mockHeaders = headers as jest.MockedFunction<typeof headers>;

  beforeEach(() => {
    mockClerkProviderProps.length = 0;
    delete process.env.NEXT_PUBLIC_CLERK_JS_URL;
    delete process.env.NEXT_PUBLIC_CLERK_JS_VERSION;
    delete process.env.NEXT_PUBLIC_CLERK_UI_URL;
    delete process.env.NEXT_PUBLIC_CLERK_UI_VERSION;
    delete process.env.HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS = "hermesos.cloud,*.hermesos.cloud";
    process.env.NEXT_PUBLIC_APP_URL = "https://hermesos.cloud";
    mockHeaders.mockResolvedValue(
      new Headers({
        host: "localhost:3000",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
      })
    );
  });

  afterEach(() => {
    if (originalPublishableKey == null) {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalPublishableKey;
    }

    if (originalAllowedOrigins == null) {
      delete process.env.NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS = originalAllowedOrigins;
    }

    if (originalAppUrl == null) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }

    if (originalClerkJsUrl == null) {
      delete process.env.NEXT_PUBLIC_CLERK_JS_URL;
    } else {
      process.env.NEXT_PUBLIC_CLERK_JS_URL = originalClerkJsUrl;
    }

    if (originalClerkJsVersion == null) {
      delete process.env.NEXT_PUBLIC_CLERK_JS_VERSION;
    } else {
      process.env.NEXT_PUBLIC_CLERK_JS_VERSION = originalClerkJsVersion;
    }

    if (originalClerkUiUrl == null) {
      delete process.env.NEXT_PUBLIC_CLERK_UI_URL;
    } else {
      process.env.NEXT_PUBLIC_CLERK_UI_URL = originalClerkUiUrl;
    }

    if (originalClerkUiVersion == null) {
      delete process.env.NEXT_PUBLIC_CLERK_UI_VERSION;
    } else {
      process.env.NEXT_PUBLIC_CLERK_UI_VERSION = originalClerkUiVersion;
    }

    if (originalAuthMode == null) {
      delete process.env.HIVRA_AUTH_MODE;
    } else {
      process.env.HIVRA_AUTH_MODE = originalAuthMode;
    }
  });

  it("uses the installation-owned provider without inspecting hosted Clerk configuration", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_example";

    render(
      await AuthClerkProvider({
        children: <div>self-host auth content</div>,
      })
    );

    expect(screen.getByText(/self-host auth content/i)).toBeInTheDocument();
    expect(screen.queryByText(/local auth setup required/i)).not.toBeInTheDocument();
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("renders setup guidance instead of Clerk on localhost with live keys", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_example";

    render(
      await AuthClerkProvider({
        children: <div>real auth content</div>,
      })
    );

    expect(screen.getByText(/local auth setup required/i)).toBeInTheDocument();
    expect(screen.getByText(/sudo npm run dev:live-auth/i)).toBeInTheDocument();
    expect(screen.getByText(/reloads the public Clerk env values/i)).toBeInTheDocument();
    expect(screen.queryByText(/real auth content/i)).not.toBeInTheDocument();
  });

  it("renders children normally with Clerk development keys", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_example";

    render(
      await AuthClerkProvider({
        children: <div>real auth content</div>,
      })
    );

    expect(screen.getByText(/real auth content/i)).toBeInTheDocument();
    expect(screen.queryByText(/local auth setup required/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("clerk-provider")).toBeInTheDocument();
  });

  it("pins Clerk runtime packages to the same-origin /clerk-assets proxy by default", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_example";

    render(
      await AuthClerkProvider({
        children: <div>real auth content</div>,
      })
    );

    expect(mockClerkProviderProps).toHaveLength(1);
    expect(mockClerkProviderProps[0]).toMatchObject({
      __internal_clerkJSVersion: "6.8.0",
      __internal_clerkUIVersion: "1.7.0",
      // Same-origin proxy (rewritten to cdn.jsdelivr.net/npm in next.config.ts):
      // direct jsdelivr loads time out for a slice of users and break sign-in.
      __internal_clerkJSUrl: "/clerk-assets/@clerk/clerk-js@6.8.0/dist/clerk.browser.js",
      __internal_clerkUIUrl: "/clerk-assets/@clerk/ui@1.7.0/dist/ui.browser.js",
    });
    expect(String(mockClerkProviderProps[0].__internal_clerkJSUrl)).not.toContain("clerk.hermesos.cloud");
    expect(String(mockClerkProviderProps[0].__internal_clerkUIUrl)).not.toContain("clerk.hermesos.cloud");
  });

  it("names the product Hivra in Clerk's copy, whatever the Clerk instance is called", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_example";

    render(await AuthClerkProvider({ children: <div>real auth content</div> }));

    expect(mockClerkProviderProps[0].localization).toMatchObject({
      signIn: { start: { title: "Sign in to Hivra" }, emailCode: { subtitle: "to continue to Hivra" } },
      signUp: { start: { title: "Create your Hivra account" } },
    });
    expect(JSON.stringify(mockClerkProviderProps[0].localization)).not.toContain("{{applicationName}}");
  });

  it("lets the NEXT_PUBLIC_CLERK_*_URL env overrides win over the same-origin defaults", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_example";
    process.env.NEXT_PUBLIC_CLERK_JS_URL =
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.8.0/dist/clerk.browser.js";
    process.env.NEXT_PUBLIC_CLERK_UI_URL =
      "https://cdn.jsdelivr.net/npm/@clerk/ui@1.7.0/dist/ui.browser.js";

    // The URLs are computed at module scope, so re-import with the env set.
    // The re-imported tree gets fresh mock instances — re-prime next/headers.
    jest.resetModules();
    const freshHeaders = (await import("next/headers")).headers as jest.MockedFunction<typeof headers>;
    freshHeaders.mockResolvedValue(
      new Headers({
        host: "localhost:3000",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-proto": "http",
      })
    );
    const { AuthClerkProvider: FreshAuthClerkProvider } = await import("../AuthClerkProvider");

    render(
      await FreshAuthClerkProvider({
        children: <div>real auth content</div>,
      })
    );

    const props = mockClerkProviderProps[mockClerkProviderProps.length - 1];
    expect(props).toMatchObject({
      __internal_clerkJSUrl: "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.8.0/dist/clerk.browser.js",
      __internal_clerkUIUrl: "https://cdn.jsdelivr.net/npm/@clerk/ui@1.7.0/dist/ui.browser.js",
    });
  });
});
