import { isWorkspaceShellEnabled } from "@/lib/flags/workspace-shell";

import DashboardPage from "../page";

jest.mock("@/lib/flags/workspace-shell", () => ({
  isWorkspaceShellEnabled: jest.fn(),
}));

jest.mock("@/components/workspace/WorkspaceView", () => ({
  WorkspaceView: () => null,
}));

jest.mock("@/components/dashboard/HermesDashboardPage", () => ({
  HermesDashboardPage: () => null,
}));

const mockedFlag = jest.mocked(isWorkspaceShellEnabled);

/**
 * The landing page picks its renderer on the SERVER flag, not the client
 * hostname check — the decision has to be made before anything ships to the
 * browser. These specs pin which component each environment gets, because
 * getting it wrong shows a Hivra surface to a Hermes-only environment.
 *
 * They assert on the returned element rather than on mock call counts: the page
 * returns `<WorkspaceView …/>` as JSX, and React is what invokes a component
 * function, at render — not this call.
 */
async function typeNameFor(searchParams: Record<string, string | string[]>) {
  const result = (await DashboardPage({
    searchParams: Promise.resolve(searchParams),
  })) as { type: { name?: string } };
  return result.type.name;
}

describe("dashboard landing page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the workspace view when the shell flag is on (canary)", async () => {
    mockedFlag.mockReturnValue(true);

    expect(
      await typeNameFor({ agent: "x-abc", surface: "desktop" }),
    ).toBe("WorkspaceView");
  });

  it("renders the Hermes command center when the flag is off (prod)", async () => {
    mockedFlag.mockReturnValue(false);

    expect(await typeNameFor({})).toBe("HermesDashboardPage");
  });

  it("forwards the query to whichever view is chosen", async () => {
    mockedFlag.mockReturnValue(true);

    const result = (await DashboardPage({
      searchParams: Promise.resolve({ agent: "x-abc", surface: "desktop" }),
    })) as { props: { searchParams: Record<string, unknown> } };

    // WorkspaceView resolves ?agent=&surface=, so the params must arrive intact.
    expect(result.props.searchParams).toEqual({
      agent: "x-abc",
      surface: "desktop",
    });
  });

  it("is a kill switch: flipping the flag changes the renderer with no code change", async () => {
    mockedFlag.mockReturnValue(true);
    expect(await typeNameFor({})).toBe("WorkspaceView");

    mockedFlag.mockReturnValue(false);
    expect(await typeNameFor({})).toBe("HermesDashboardPage");
  });
});
