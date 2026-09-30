/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";

import { HIVRA_MARK_SRC, HivraMark } from "../HivraMark";

// The header, funnel bar and homepage scene show the approved raster mark,
// not the retired rail-and-bar SVG.
describe("HivraMark", () => {
  it("renders the exported approved mark at the requested size with alt text", () => {
    const { container } = render(<HivraMark size={32} className="brand" style={{ marginTop: 2 }} />);
    const mark = screen.getByTestId("hivra-mark");
    expect(mark.tagName).toBe("IMG");
    expect(mark).toHaveAttribute("src", "/brand/hivra-icon-192.png");
    expect(mark).toHaveAttribute("alt", "Hivra");
    expect(mark).toHaveAttribute("width", "32");
    expect(mark).toHaveAttribute("height", "32");
    expect(mark).toHaveClass("brand");
    expect(mark).toHaveStyle({ display: "block", marginTop: "2px" });
    expect(container.querySelector("svg")).toBeNull();
  });

  it("defaults to 40px", () => {
    render(<HivraMark />);
    expect(screen.getByTestId("hivra-mark")).toHaveAttribute("width", "40");
  });

  it("points at the committed 192px export of the approved logo", () => {
    const file = join(process.cwd(), "public", HIVRA_MARK_SRC);
    expect(existsSync(file)).toBe(true);
    // Same bytes as the owner-asserted export recorded in docs/release/asset-owner-assertions.json.
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
      "1d1c4851fec1846a692b2236ee58bb3898f61178d931aac63ffd0e4d1e1a479d",
    );
  });
});
