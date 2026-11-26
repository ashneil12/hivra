/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { auth } from "@clerk/nextjs/server";
import { isHolderTierCarryoverEnabled } from "@/lib/billing/token-access";
import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { HolderSwitchNotice } from "../HolderSwitchNotice";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/token-access", () => ({ isHolderTierCarryoverEnabled: jest.fn() }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn() }));
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: jest.fn() }));

const gate = { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null, carryover: { tiers: [] } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isHolderTierCarryoverEnabled).mockReturnValue(true);
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "fixture-user" });
  (resolveTokenGeoBlockForPage as jest.Mock).mockResolvedValue({ blocked: false });
  jest.mocked(readConversionAccessGate).mockResolvedValue(gate);
});

it("links an eligible grandfathered account with no earned higher tier to its own holder page", async () => {
  render(await HolderSwitchNotice());
  expect(screen.getByRole("link", { name: "Review my holder access" })).toHaveAttribute("href", "/dashboard/convert");
  expect(readConversionAccessGate).toHaveBeenCalledWith("fixture-user", expect.any(Date), { recordMembership: false });
});

it.each([null, { ...gate, grandfathered: false }, { ...gate, convertedAt: "2026-01-01T00:00:00Z" }, { ...gate, carryover: null }])(
  "hides the notice for an ineligible, switched or indeterminate account", async (value) => {
    jest.mocked(readConversionAccessGate).mockResolvedValue(value);
    expect(await HolderSwitchNotice()).toBeNull();
  },
);

it("skips all access and geographic reads while disabled", async () => {
  jest.mocked(isHolderTierCarryoverEnabled).mockReturnValue(false);
  expect(await HolderSwitchNotice()).toBeNull();
  expect(auth).not.toHaveBeenCalled();
  expect(resolveTokenGeoBlockForPage).not.toHaveBeenCalled();
  expect(readConversionAccessGate).not.toHaveBeenCalled();
});

it("hides the notice before reading the account when the country is restricted", async () => {
  (resolveTokenGeoBlockForPage as jest.Mock).mockResolvedValue({ blocked: true });
  expect(await HolderSwitchNotice()).toBeNull();
  expect(readConversionAccessGate).not.toHaveBeenCalled();
});
