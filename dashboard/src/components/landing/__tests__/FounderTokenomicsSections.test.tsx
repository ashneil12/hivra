/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import FounderSection, { FOUNDER_EXCERPTS } from "../FounderSection";
import TokenomicsSection from "../FullTokenomicsSection";

const litepaper = readFileSync(path.resolve(__dirname, "../../../../../LITEPAPER.md"), "utf8");

test("homepage founder note uses complete Litepaper excerpts and links the full piece", () => {
 const {container}=render(<FounderSection />);
 for (const paragraph of FOUNDER_EXCERPTS) { expect(screen.getByText(paragraph)).toBeVisible(); expect(litepaper).toContain(paragraph); }
 expect(container.querySelectorAll("blockquote p")).toHaveLength(5);
 expect(screen.getByRole("link",{name:/Read why I'm building Hivra/})).toHaveAttribute("href","/why-hivra");
});
test("token access is distinct from an optional claim and does not promise a conversion ratio", () => {
  render(<TokenomicsSection />);
  expect(screen.getByText(/The amount you need is fixed when your holding first qualifies/)).toBeVisible();
  expect(screen.getByText(/as long as you keep holding it/)).toBeVisible();
  expect(screen.getByText(/a year of Pro is \$49 in the token against \$79 by card/)).toBeVisible();
  expect(screen.getByText(/Self-hosting Hivra requires neither the token nor a Hivra account/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Keeping access and converting tokens are separate decisions." })).toBeVisible();
  expect(screen.getByText(/without forced conversion or a claim deadline/)).toBeVisible();
  expect(screen.getByText(/The rate is a live market quote, not a fixed ratio/)).toBeVisible();
  expect(screen.getByText(/new users hold and pay with \$HIVRA/)).toBeVisible();
  expect(screen.queryByText(/1:1|guaranteed return|buy now/i)).not.toBeInTheDocument();
});

test("the full founder source retains the faith, accountability and reference paragraphs", () => {
 const full=readFileSync(path.resolve(__dirname,"../../../../../THOUGHTS.md"),"utf8");
 for(const text of ["I'm also a Christian", "scripture already described", "Someone has to be answerable", "https://projectzero.google/", "https://www.anthropic.com/"]) expect(full).toContain(text);
 expect(litepaper).toContain(full.split("\n\n")[1]);
});
test("proposed uses and treasury retain their boundaries and direct reading links", () => {
  render(<TokenomicsSection />);
  expect(screen.getByText(/migration, new uses and treasury plans are proposals/)).toBeVisible();
  expect(screen.getByText(/Contributors choose stablecoin or \$HIVRA at equivalent value/)).toBeVisible();
  expect(screen.getByText(/Purchases, sales and payments would all be published/)).toBeVisible();
  expect(screen.getByText(/Tokens held in the treasury aren.t burned/)).toBeVisible();
  expect(screen.getByText(/No fixed share of revenue committed to buying tokens/)).toBeVisible();
  for (const rule of ["No staking or yield.", "No company ownership.", "No buying extra authority."]) {
    expect(screen.getByText(rule)).toBeVisible();
  }
  expect(screen.getByText(/The supply is fixed at 100 billion by the Bankr launch/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Read the full tokenomics" })).toHaveAttribute("href", "/docs/litepaper/index.html#economy");
  expect(screen.getByRole("link", { name: "Read the tokenomics document" })).toHaveAttribute("href", "/TOKENOMICS.md");
  screen.getAllByRole("link").forEach(link => {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
test("tokenomics paraphrase stays inside the approved Litepaper wording and drops retired uses", () => {
  const { container } = render(<TokenomicsSection />);
  for (const sentence of [
    "The amount you need is fixed when your holding first qualifies.",
    "a year of Pro is $49 in the token against $79 by card, and credit top-ups paid in the token come with bonus credits. Token payments are final.",
    "You'd sign it from your own wallet, and Hivra never holds your tokens.",
    "The rate is a live market quote, not a fixed ratio. The fees and a maximum slippage limit get published before claims open.",
    "Once $HIVRA launches, new users hold and pay with $HIVRA.",
    "Nothing here is an offer or an inducement to buy any asset.",
    "The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.",
  ]) {
    expect(litepaper).toContain(sentence);
    expect(container.textContent).toContain(sentence);
  }
  expect(container.textContent).not.toMatch(/Nibbii|remain to be settled|fixed at deposit/);
});
