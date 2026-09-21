/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

jest.mock("@/components/explorer/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="file-explorer-stub">file explorer</div>,
}));

jest.mock("@/lib/explorer-home", () => ({
  resolveExplorerHome: jest.fn(() => "/opt/hermes/instances/inst_123"),
}));

const DedicatedFileExplorerPage = jest.requireActual("../page").default as typeof import("../page").default;

describe("DedicatedFileExplorerPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the dedicated explorer frame with a modest inner padding", async () => {
    await act(async () => {
      render(<DedicatedFileExplorerPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    const explorer = await screen.findByTestId("file-explorer-stub");
    expect(explorer.parentElement).toHaveStyle({ padding: "12px" });
  });
});
