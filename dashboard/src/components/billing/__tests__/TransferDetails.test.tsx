/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import {
  CopyButton,
  DepositAddressField,
  OpenInWalletLink,
  TransferAmountField,
} from "../TransferDetails";
import { copyTextToClipboard } from "@/lib/client/clipboard";

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));

const copyMock = copyTextToClipboard as jest.MockedFunction<typeof copyTextToClipboard>;
const ADDRESS = "0x000000000000000000000000000000000000fEeD";

function mockViewport(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: compact,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
    })),
  });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("CopyButton", () => {
  it("copies the exact value and confirms, then resets", async () => {
    jest.useFakeTimers();
    copyMock.mockResolvedValue(true);
    render(<CopyButton value="19600000" label="Copy amount" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy amount" }));
    });
    expect(copyMock).toHaveBeenCalledWith("19600000");
    expect(screen.getByRole("button")).toHaveTextContent("Copied");

    act(() => {
      jest.advanceTimersByTime(1600);
    });
    expect(screen.getByRole("button")).toHaveTextContent("Copy amount");
    jest.useRealTimers();
  });

  it("does not claim a copy that failed", async () => {
    copyMock.mockResolvedValue(false);
    render(<CopyButton value="abc" label="Copy address" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });
    expect(screen.getByRole("button")).toHaveTextContent("Copy address");
  });

  it("is disabled when there is nothing to copy", () => {
    render(<CopyButton value={null} label="Copy address" />);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeDisabled();
  });
});

describe("TransferAmountField", () => {
  it("shows the amount with its unit and a copy button under it", () => {
    render(
      <TransferAmountField label="Send exactly" amount="19,600,000" unit="Hivra" copyValue="19600000">
        $49.00 worth.
      </TransferAmountField>
    );
    expect(screen.getByText("19,600,000")).toBeInTheDocument();
    expect(screen.getByText("Hivra")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy amount" })).toBeInTheDocument();
    expect(screen.getByText("$49.00 worth.")).toBeInTheDocument();
  });
});

describe("DepositAddressField", () => {
  it("keeps the QR beside the address on desktop (no disclosure)", () => {
    mockViewport(false);
    render(<DepositAddressField label="Deposit address" address={ADDRESS} qrLabel="Deposit QR" />);
    expect(screen.getByTestId("qr").closest("details")).toBeNull();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  });

  it("on phones puts the QR after the copy button inside a closed 'Show QR code' disclosure", () => {
    mockViewport(true);
    render(<DepositAddressField label="Deposit address" address={ADDRESS} qrLabel="Deposit QR" />);
    const details = screen.getByText("Show QR code").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByTestId("qr")).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy address" });
    expect(copy.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a placeholder, no QR and a disabled copy button without an address", () => {
    render(<DepositAddressField label="Deposit address" address={null} qrLabel="Deposit QR" />);
    expect(screen.queryByTestId("qr")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeDisabled();
  });

  it("keeps an explicit accessible name on the copy button when one is given", () => {
    render(
      <DepositAddressField
        label="Step 2"
        address={ADDRESS}
        qrLabel="QR"
        copyAriaLabel="Copy Step 2"
      />
    );
    expect(screen.getByRole("button", { name: "Copy Step 2" })).toBeInTheDocument();
  });
});

describe("OpenInWalletLink", () => {
  it("renders a real link for a known transfer", () => {
    render(<OpenInWalletLink href="ethereum:0xabc@8453/transfer?address=0xdef&uint256=1" />);
    expect(screen.getByRole("link", { name: /open in wallet/i })).toHaveAttribute(
      "href",
      "ethereum:0xabc@8453/transfer?address=0xdef&uint256=1"
    );
  });

  it("renders nothing when the transfer is not fully known", () => {
    const { container } = render(<OpenInWalletLink href={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
