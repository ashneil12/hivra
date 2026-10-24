/** @jest-environment node */
import { redirect } from "next/navigation";

import { PUBLIC_START_HREF } from "@/lib/public-start";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import ReservePage, { metadata as reserveMetadata } from "../page";
import ReservedPage, { metadata as reservedMetadata } from "../../reserved/page";

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));

// /reserve and /reserved only redirect to sign-up, but their description is what a link preview or a crawler reads.
// It used to say "launch an agent or a computer on Hivra", which reads as a free start. Hivra runs no free computer
// (owner decision, 21 October 2026), so it now says what a free account is for and what is paid.
const DASH = new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`);
const DESCRIPTION =
  "Create your Hivra account. A free account works with a computer or server you connect yourself. Every Hivra Cloud computer needs a paid plan.";

describe("/reserve and /reserved", () => {
  it.each([
    ["/reserve", reserveMetadata],
    ["/reserved", reservedMetadata],
  ])("%s describes the account without offering a free Hivra computer", (_route, metadata) => {
    expect(metadata.description).toBe(DESCRIPTION);
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(findBannedClaims(String(metadata.description))).toEqual([]);
    expect(String(metadata.description)).not.toMatch(DASH);
    expect(String(metadata.description)).not.toMatch(/launch an agent or a computer/i);
  });

  it("both send the visitor to sign-up", () => {
    ReservePage();
    ReservedPage();
    expect(redirect).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenNthCalledWith(1, PUBLIC_START_HREF);
    expect(redirect).toHaveBeenNthCalledWith(2, PUBLIC_START_HREF);
    expect(PUBLIC_START_HREF).toBe("/sign-up");
  });
});
