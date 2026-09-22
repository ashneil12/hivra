/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import FounderSection, { FOUNDER_EXCERPTS } from "../FounderSection";
import TokenomicsSection from "../FullTokenomicsSection";
import CompactTokenomicsSection from "../TokenomicsSection";

const litepaper = readFileSync(path.resolve(__dirname, "../../../../../LITEPAPER.md"), "utf8");

test("homepage founder note uses complete Litepaper excerpts and links the full piece", () => {
 const {container}=render(<FounderSection />);
 for (const paragraph of FOUNDER_EXCERPTS) { expect(screen.getByText(paragraph)).toBeVisible(); expect(litepaper).toContain(paragraph); }
 expect(container.querySelectorAll("blockquote p")).toHaveLength(5);
 expect(screen.getByRole("link",{name:/Read why I'm building Hivra/})).toHaveAttribute("href","/why-hivra");
});
test("homepage names both tokens and groups migration, uses and Litepaper reading", () => {
 render(<CompactTokenomicsSection />);
 expect(screen.getByRole("heading",{name:"$HIVRA"})).toBeVisible();
 expect(screen.getByText("$HermesOS",{exact:true})).toBeVisible();
 expect(screen.getByRole("heading",{name:"What happened to HermesOS?"})).toBeVisible();
 expect(screen.getByText(/separate, optional choice/)).toBeVisible();
 expect(screen.getByText(/maintain that balance/)).toBeVisible();
 expect(screen.getByText(/Card payments remain available/)).toBeVisible();
 expect(screen.getByText("Proposed uses")).toBeVisible();
 for(const title of ["Computers and Nibbii","Tools and useful work","Security worth testing"]) expect(screen.getByRole("heading",{name:title})).toBeVisible();
 expect(screen.getByRole("link",{name:"Read the tokenomics"})).toHaveAttribute("href","/tokenomics");
 expect(screen.getByRole("link",{name:"Read the Litepaper"})).toHaveAttribute("href","/docs/litepaper/index.html#economy");
 expect(screen.getByRole("link",{name:"Nibbii"})).toHaveAttribute("href","https://nibbii.pet/");
 screen.getAllByRole("link").forEach(link=>expect(link).toHaveAttribute("rel","noopener noreferrer"));
});
test("token access is distinct from an optional claim and does not promise a conversion ratio", () => {
  render(<TokenomicsSection />);
  expect(screen.getByText(/required token quantity is fixed at deposit/)).toBeVisible();
  expect(screen.getByText(/maintain the qualifying balance/)).toBeVisible();
  expect(screen.getByText(/Self-hosting requires neither the token nor a Hivra account/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Keeping access and converting tokens are separate decisions." })).toBeVisible();
  expect(screen.getByText(/without forced conversion or a claim deadline/)).toBeVisible();
  expect(screen.getByText(/conversion rate, fees and protection against price movement will be published/)).toBeVisible();
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
  expect(screen.getByText(/Contributors choose stablecoin or Hivra at equivalent value/)).toBeVisible();
  expect(screen.getByText(/Purchases, sales and payments would all be published/)).toBeVisible();
  expect(screen.getByText(/Treasury tokens circulate again; they are not burned/)).toBeVisible();
  expect(screen.getByText(/No fixed share of revenue committed to buying tokens/)).toBeVisible();
  for (const rule of ["No staking or yield.", "No company ownership.", "No buying extra authority."]) {
    expect(screen.getByText(rule)).toBeVisible();
  }
  expect(screen.getByText(/Supply, any founder allocation and its vesting remain to be settled/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Read the full tokenomics" })).toHaveAttribute("href", "/docs/litepaper/index.html#economy");
  expect(screen.getByRole("link", { name: "Read the tokenomics document" })).toHaveAttribute("href", "/TOKENOMICS.md");
  screen.getAllByRole("link").forEach(link => {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
