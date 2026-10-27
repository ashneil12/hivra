/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import TokenomicsSection from "../FullTokenomicsSection";

// These cases cover the dormant section, so they pass the phase explicitly (the committed launch block is filled
// in). The launched section is covered in src/components/token/__tests__/TokenomicsLaunchedView.test.tsx.
const litepaper = readFileSync(path.resolve(__dirname, "../../../../../LITEPAPER.md"), "utf8");

test("token access is distinct from an optional claim and does not promise a conversion ratio", () => {
  render(<TokenomicsSection phase="dormant" />);
  expect(screen.getByText(/The amount you need is fixed when your holding first qualifies/)).toBeVisible();
  expect(screen.getByText(/as long as you keep holding it/)).toBeVisible();
  expect(screen.getByText(/a year of Pro is \$49 in the token against \$79 by card/)).toBeVisible();
  expect(screen.getByText(/Self-hosting Hivra requires neither the token nor a Hivra account/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Keeping access and converting tokens are separate decisions." })).toBeVisible();
  expect(screen.getByText(/without forced conversion or a claim deadline/)).toBeVisible();
  expect(screen.getByText(/Bankr would run the conversion/)).toBeVisible();
  expect(screen.getByText(/new users hold and pay with \$HIVRA/)).toBeVisible();
  expect(screen.queryByText(/1:1|guaranteed return|buy now/i)).not.toBeInTheDocument();
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
test("proposed uses and treasury retain their boundaries and direct reading links", () => {
  render(<TokenomicsSection phase="dormant" />);
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
test("the pre-launch tokenomics paraphrase stays inside the Litepaper's current wording, and keeps only the retired Bankr proposal the Litepaper no longer carries", () => {
  const { container } = render(<TokenomicsSection phase="dormant" />);
  for (const sentence of [
    "The amount you need is fixed when your holding first qualifies.",
    "Nothing here is an offer or an inducement to buy any asset.",
  ]) {
    expect(litepaper).toContain(sentence);
    expect(container.textContent).toContain(sentence);
  }
  // The dormant page is the proposal as it stood before the launch and does not change until the launch block is filled
  // in. The Litepaper was rewritten on 20 October 2026 for the snapshot and Sablier claim (Ash's website pack), so these
  // sentences are no longer in it; only the dormant page, which is not served once the new token surfaces are on with a
  // launch block, still carries them.
  for (const retired of [
    "a year of Pro is $49 in the token against $79 by card, and credit top-ups paid in the token come with bonus credits.",
    "Bankr would run the conversion.",
    "The conversion rate, the fees and how price changes during a conversion are handled get published before claims open, along with the exact steps.",
    "Once $HIVRA launches, new users hold and pay with $HIVRA.",
    "The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.",
  ]) {
    expect(container.textContent).toContain(retired);
    expect(litepaper).not.toContain(retired);
  }
  // UK consumers keep a 14-day right to cancel (CCR 2013 regs 29, 30, 36), so the
  // site must not repeat the Litepaper's bare "final" without the exception.
  expect(container.textContent).toContain("Token payments are final, except where the law gives you a right to cancel.");
  expect(container.textContent).not.toMatch(/Nibbii|remain to be settled|fixed at deposit|own wallet|market quote/);
});
test("the Litepaper and the standalone tokenomics document no longer describe the Bankr claim, token pricing or an automatic send", () => {
  for (const document of [litepaper, readFileSync(path.resolve(__dirname, "../../../../../TOKENOMICS.md"), "utf8")]) {
    expect(document).not.toMatch(/Bankr|sent automatically|no claim deadline|new users hold and pay|\$49|\$79|bonus credits|sell your old tokens/);
    expect(document).toContain("This is **not an automatic transfer**.");
    expect(document).toContain("Eligible holders must claim through the official **Sablier** process.");
    expect(document).toContain("The current claim arrangement does **not** require holders to burn or surrender their original $HermesOS.");
    expect(document).toContain("There is no separate team allocation of $HIVRA in the current migration plan.");
  }
});
test.each(["scheduled", "active"] as const)("a launched (%s) section is Ash's pack page: a holder-paid Sablier claim, no Bankr claim, no automatic airdrop, no token pricing", (phase) => {
  const { container } = render(<TokenomicsSection phase={phase} headingLevel={1} airdropLookupHref={null} migrationHref={null} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("$HIVRA: what it's for");
  expect(screen.getByRole("heading", { name: "A snapshot has been taken. Eligible holders can claim." })).toBeVisible();
  expect(container.textContent).toContain("This is not an automatic transfer.");
  expect(container.textContent).not.toMatch(/Bankr|ETH proceeds|active claim|claims open|migration, new uses/);
  expect(container.textContent).not.toMatch(/Nothing to claim|Nothing to swap|Airdrop flow|new users hold and pay|\$49|\$79|bonus credits/);
});

test("a launched section hands the dormant copy nothing: the dormant section is unchanged", () => {
  const { container } = render(<TokenomicsSection phase="dormant" />);
  expect(screen.getByRole("heading", { name: "Keeping access and converting tokens are separate decisions." })).toBeVisible();
  expect(container.textContent).toContain("a year of Pro is $49 in the token against $79 by card");
  expect(container.textContent).not.toContain("A snapshot has been taken");
});
