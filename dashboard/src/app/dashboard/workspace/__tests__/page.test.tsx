import { readFileSync } from "node:fs";
import { join } from "node:path";

import { redirect } from "next/navigation";

import WorkspacePage from "../page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

const mockedRedirect = jest.mocked(redirect);

describe("workspace server page", () => {
  beforeEach(() => {
    mockedRedirect.mockClear();
  });

  it("forwards the whole query string to the landing page", async () => {
    // The interaction area moved to /dashboard, but this URL contract has to
    // survive — ~15 href producers, the PWA manifest and every bookmark point
    // here with ?agent=&surface=. One implementation resolves it (WorkspaceView,
    // reached from /dashboard); this route only forwards.
    await expect(
      WorkspacePage({
        searchParams: Promise.resolve({
          agent: "x-123e4567-e89b-12d3-a456-426614174000",
          surface: "desktop",
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(mockedRedirect).toHaveBeenCalledWith(
      "/dashboard?agent=x-123e4567-e89b-12d3-a456-426614174000&surface=desktop",
    );
  });

  it("sends a bare visit to the landing page with no query", async () => {
    await expect(
      WorkspacePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(mockedRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("preserves extra params rather than dropping them", async () => {
    // A hand-built link may carry params this route does not know about;
    // dropping them silently would land the user somewhere subtly different.
    await expect(
      WorkspacePage({
        searchParams: Promise.resolve({ agent: "x-abc", surface: "files", tab: "x" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(mockedRedirect).toHaveBeenCalledWith(
      "/dashboard?agent=x-abc&surface=files&tab=x",
    );
  });

  it.each([
    "src/app/dashboard/agent/[id]/page.tsx",
    "src/app/dashboard/instances/[id]/page.tsx",
  ])("keeps the legacy route at %s independent from workspace redirects", (routePath) => {
    const source = readFileSync(join(process.cwd(), routePath), "utf8");

    expect(source).not.toContain("/dashboard/workspace");
    expect(source).not.toContain("isWorkspaceShellEnabled");
  });
});
