/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { resolveConversionState, type ConversionInputs } from "@/lib/claim/conversion-state";

import { ANNOUNCED_MESSAGE, ConvertPanel, DORMANT_MESSAGE, PROPOSED_LABEL } from "../ConvertPanel";

const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TERMS = "https://hivra.cloud/token/conversion-terms";
const CONVERT = "https://bankr.bot/convert/hivra";

const validation = validateHivraLaunchConfig({
  contractAddress: TEST_HIVRA,
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
});
const testHivra = validation.status === "configured" ? validation.token : null;

const DORMANT: ConversionInputs = { hivra: null, phase: "dormant", links: { termsUrl: null, conversionUrl: null }, access: null };

function renderState(overrides: Partial<ConversionInputs> = {}) {
  return render(<ConvertPanel state={resolveConversionState({ ...DORMANT, ...overrides })} />);
}

describe("ConvertPanel", () => {
  it("is dormant with no $HIVRA configured: exact message, proposed label, no conversion link", () => {
    renderState();

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion opens after $HIVRA launches; terms are published first.",
    );
    expect(DORMANT_MESSAGE).toBe("Conversion opens after $HIVRA launches; terms are published first.");
    expect(screen.getByTestId("convert-proposed-label")).toHaveTextContent(PROPOSED_LABEL);
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /conversion terms/i })).not.toBeInTheDocument();
    expect(screen.getByText(/There is no official \$HIVRA contract yet/)).toBeInTheDocument();
  });

  it("frames optional conversion and kept access as proposals, and says how access works today", () => {
    renderState();

    expect(screen.getByText(/As proposed, converting is optional/)).toBeInTheDocument();
    expect(screen.getByText(/Today, platform access counts the \$HermesOS in your verified wallet/)).toBeInTheDocument();
    expect(screen.getByText(/The proposal is that existing holders keep their access/)).toBeInTheDocument();
  });

  it("points platform-wallet holders to their wallet instead of converting for them", () => {
    renderState();

    expect(screen.getByRole("link", { name: "Open Wallet" })).toHaveAttribute("href", "/dashboard/wallet");
  });

  it("shows the registry contract but no conversion link until the user's access counts $HIVRA", () => {
    renderState({ hivra: testHivra, phase: "active", links: { termsUrl: TERMS, conversionUrl: CONVERT }, access: null });

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(ANNOUNCED_MESSAGE);
    expect(screen.queryByText(DORMANT_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText(TEST_HIVRA)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
  });

  it("links to terms and conversion once everything is in place", () => {
    renderState({ hivra: testHivra, phase: "active", links: { termsUrl: TERMS, conversionUrl: CONVERT }, access: { canConvert: true } });

    expect(screen.queryByTestId("convert-closed")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read the conversion terms" })).toHaveAttribute("href", TERMS);
    expect(screen.getByRole("link", { name: "Go to conversion" })).toHaveAttribute("href", CONVERT);
  });

  it("checks a pasted address against the official contracts only", () => {
    renderState();

    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: TEST_HIVRA } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("status")).toHaveTextContent(/This is not a Hivra token\. \$HIVRA has not launched/);
    // The pasted value never becomes a link.
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href")?.includes(TEST_HIVRA))).toBe(false);
  });
});
