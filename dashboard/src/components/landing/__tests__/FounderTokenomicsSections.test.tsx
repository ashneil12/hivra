/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import TokenomicsSection from "../FullTokenomicsSection";

// The founder copy was approved against the September litepaper; the 23 October litepaper rewrote the founder letter.
const litepaper = readFileSync(path.resolve(__dirname, "fixtures/litepaper-2026-09-approved.md"), "utf8");

test("token access is distinct from the optional claim and promises no conversion value", () => {
  render(<TokenomicsSection phase="dormant" />);
  expect(screen.getByText(/The amount you need is fixed when your holding first qualifies/)).toBeVisible();
  expect(screen.getByText(/as long as you keep holding it/)).toBeVisible();
  expect(screen.getByText(/Self-hosting Hivra requires neither the token nor a Hivra account/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Moving from $HermesOS to $HIVRA" })).toBeVisible();
  expect(screen.getByText(/You do not need to burn or surrender it to claim/)).toBeVisible();
  expect(screen.queryByText(/Bankr|ETH proceeds|guaranteed return|buy now/i)).not.toBeInTheDocument();
});

test("the full founder source retains the faith, accountability and reference paragraphs", () => {
 const full=readFileSync(path.resolve(__dirname,"../../../../../THOUGHTS.md"),"utf8");
 for(const text of ["I'm also a Christian", "scripture already described", "Someone has to be answerable", "https://projectzero.google/", "https://www.anthropic.com/"]) expect(full).toContain(text);
 // The litepaper carries a shorter founder letter that links here, with the
 // scripture passage word for word; THOUGHTS.md keeps the full version.
 expect(litepaper).toContain("](THOUGHTS.md)");
 const scripture = full.split("\n\n").find(paragraph => paragraph.includes("scripture already described"));
 expect(litepaper).toContain(scripture);
});
test("the prelaunch tokenomics page states the fee split, no founder allocation and the document links", () => {
  const { container } = render(<TokenomicsSection phase="dormant" />);
  expect(screen.getByRole("heading", { name: /Trading fees: about 1\.58% in total/ })).toBeVisible();
  expect(screen.getByText(/not automatically locked and does not compound/)).toBeVisible();
  expect(screen.getByText(/No founder allocation of new \$HIVRA is planned/, { selector: "p" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Read the tokenomics document" })).toHaveAttribute("href", "/TOKENOMICS.md");
  expect(container.textContent).not.toMatch(/Bankr would|supply is fixed at 100 billion|\$49|buyback and burn/);
});
