import DashboardPage from "../page";

jest.mock("@/components/workspace/WorkspaceView", () => ({
  WorkspaceView: () => null,
}));

describe("dashboard landing page", () => {
  it("renders the workspace view and forwards the query to it", async () => {
    const result = (await DashboardPage({
      searchParams: Promise.resolve({ agent: "x-abc", surface: "desktop" }),
    })) as { type: { name?: string }; props: { searchParams: Record<string, unknown> } };

    expect(result.type.name).toBe("WorkspaceView");
    // WorkspaceView resolves ?agent=&surface=, so the params must arrive intact.
    expect(result.props.searchParams).toEqual({ agent: "x-abc", surface: "desktop" });
  });
});
