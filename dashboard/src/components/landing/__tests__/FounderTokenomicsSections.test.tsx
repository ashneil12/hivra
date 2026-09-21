/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import FounderSection, { FOUNDER_EXCERPTS } from "../FounderSection";
import TokenomicsSection from "../TokenomicsSection";

const litepaper = readFileSync(path.resolve(__dirname, "../../../../../LITEPAPER.md"), "utf8");

test("the founder quotation preserves the approved words and personal attribution", () => {
  const { container } = render(<FounderSection />);
  const quote = container.querySelector("blockquote")!;
  for (const paragraph of FOUNDER_EXCERPTS) {
    expect(litepaper).toContain(paragraph);
    expect(within(quote).getByText(paragraph)).toBeVisible();
  }
  expect(screen.getByText("Ash's personal perspective")).toBeVisible();
  expect(screen.getByText(/End-time prophecy\. Evangelism\./)).toBeVisible();
  const invitation = screen.getByRole("link", { name: /Read why I'm building Hivra/ });
  expect(invitation).toHaveAttribute("href", "/docs/litepaper/index.html#founder");
  expect(invitation).toHaveAttribute("target", "_blank");
  expect(invitation).toHaveAttribute("rel", "noopener noreferrer");
  expect(container.querySelector('a[href="/WHY.md"]')).toBeNull();
  expect(screen.queryByText(/the rest of this page stands on its own/i)).not.toBeInTheDocument();
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

test("the founder section uses the litepaper wording without an invented faith note", () => {
  render(<FounderSection />);
  expect(screen.queryByRole("complementary", { name: "Faith and the future" })).not.toBeInTheDocument();
  expect(screen.getByText(/scripture already described/)).toBeVisible();
  expect(screen.getByText(/Someone has to be answerable/)).toBeVisible();
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
