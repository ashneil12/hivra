/** @jest-environment jsdom */
/**
 * HIVRA_NEW_TOKEN_SURFACES is a server-only switch: a client component that
 * renders the public header and footer without being told its value reads "off"
 * in the browser, drops the litepaper link the server rendered and makes React
 * report a hydration mismatch. /token (TokenPageClient and the launched view it
 * hands over to) must pass the server's answer on to PublicSite in every state.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import TokenPageClient from "../TokenPageClient";
import type { TokenPageEntry } from "@/lib/token-verification-content";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children, tokenSurfaces }: { children: React.ReactNode; tokenSurfaces?: boolean }) => (
    <div data-testid="public-site" data-token-surfaces={String(tokenSurfaces)}>{children}</div>
  ),
}));

const HERMESOS: TokenPageEntry = {
  key: "hermesos",
  label: "$HermesOS",
  status: "legacy",
  contractAddress: "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
  basescanUrl: "https://basescan.org/token/0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
  activatesAt: null,
};
const HIVRA_LIVE: TokenPageEntry = {
  key: "hivra",
  label: "$HIVRA",
  status: "live",
  contractAddress: "0x1111111111111111111111111111111111111111",
  basescanUrl: "https://basescan.org/token/0x1111111111111111111111111111111111111111",
  activatesAt: "2026-10-01T16:00:00.000Z",
};
const HIVRA_DORMANT: TokenPageEntry = { ...HIVRA_LIVE, status: "not_launched", contractAddress: null, basescanUrl: null, activatesAt: null };

const surfaces = () => screen.getByTestId("public-site").getAttribute("data-token-surfaces");

describe.each([true, false])("TokenPageClient told tokenSurfaces=%s", (value) => {
  it("passes it to the header and footer on the launched page", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} tokenSurfaces={value} />);
    expect(screen.getByRole("heading", { level: 1, name: "$HIVRA and $HermesOS" })).toBeInTheDocument();
    expect(surfaces()).toBe(String(value));
  });

  it("passes it on the dormant page", () => {
    render(<TokenPageClient entries={[HERMESOS, HIVRA_DORMANT]} tokenSurfaces={value} />);
    expect(surfaces()).toBe(String(value));
  });

  it("passes it on the page a viewer the token geo-policy blocks reads", () => {
    render(<TokenPageClient entries={[HIVRA_LIVE, HERMESOS]} geoNotice="Token features aren't available to you." tokenSurfaces={value} />);
    expect(screen.getByTestId("token-geo-notice")).toBeInTheDocument();
    expect(surfaces()).toBe(String(value));
  });
});

it("leaves the choice to PublicSite when the page is rendered without the prop (a server page or a test)", () => {
  render(<TokenPageClient entries={[HERMESOS, HIVRA_DORMANT]} />);
  expect(surfaces()).toBe("undefined");
});
