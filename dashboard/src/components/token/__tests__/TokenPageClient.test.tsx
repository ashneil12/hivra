/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import { getTokenPageEntries } from "@/lib/token-verification-content";

const mockCopy = jest.fn();
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: (value: string) => mockCopy(value) }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("TokenPageClient contract address", () => {
  it("copies the full contract address and confirms it", async () => {
    mockCopy.mockResolvedValue(true);
    render(<TokenPageClient entries={getTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(mockCopy).toHaveBeenCalledWith("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.getByRole("button", { name: "Address copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Contract address copied");
  });

  it("tells the reader to select the address when the copy fails", async () => {
    mockCopy.mockResolvedValue(false);
    render(<TokenPageClient entries={getTokenPageEntries()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });

    expect(screen.getByRole("status")).toHaveTextContent(/select the address/i);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  });
});
