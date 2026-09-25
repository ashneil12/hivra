/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import LandingPage from "@/app/page";
import DownloadPage from "@/app/download/page";
import { AGENT_LAUNCH_HREF, HOMEPAGE_FAQ, HOME_AGENTS } from "@/components/landing/home/content";

jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
jest.mock("@/components/public-site/PublicSite", () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));

async function renderHome() {
  return render(await LandingPage({}));
}

test("the first screen says what it is, who it is for, what it costs, and asks once", async () => {
  await renderHome();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your agent needs a computer. It doesn't need yours.");
  expect(screen.getByText(/Run Claude Code, Codex, Hermes and more on a private cloud computer of their own\..*From \$9\.99 a month\./)).toBeInTheDocument();
  expect(document.getElementById("hero-primary-cta")).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(screen.getByRole("link", { name: /Hermes OS is now Hivra/ })).toHaveAttribute("href", "/why-hivra/evolution");
  expect(screen.getAllByText("7-day money-back guarantee on card payments.").length).toBeGreaterThan(0);
  // The old page's app download and tab switcher are gone.
  expect(screen.queryByRole("link", { name: "Download the app" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

test("every section the header and footer link to is still on the page", async () => {
  await renderHome();
  for (const id of ["why", "launch", "agents", "computers", "workspace", "open-source", "pricing", "hosting", "founder", "faq", "start"]) {
    expect(document.getElementById(id)).not.toBeNull();
  }
});

test("each agent card launches that agent, and computers launch on their own", async () => {
  await renderHome();
  for (const agent of HOME_AGENTS) {
    expect(screen.getByRole("link", { name: `Launch ${agent.name}` })).toHaveAttribute("href", agent.href);
  }
  expect(screen.getByRole("link", { name: /Launch Ubuntu/ })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  const previews = within(screen.getByRole("list", { name: "Private preview computers" }));
  expect(previews.getByRole("link", { name: /Windows/ })).toHaveTextContent("Private preview");
  expect(previews.getByRole("link", { name: /Omarchy/ })).toHaveTextContent("Private preview");
});

test("pricing shows only what can be bought today and links straight to checkout", async () => {
  await renderHome();
  const pricing = within(document.getElementById("pricing") as HTMLElement);
  expect(pricing.getAllByRole("article")).toHaveLength(3);
  expect(pricing.getByRole("link", { name: /Launch on Hivra Cloud/ })).toHaveAttribute("href", "/get-started?plan=operator");
  expect(pricing.getByRole("link", { name: /Choose this size/ })).toHaveAttribute("href", "/get-started?plan=fleet");
  expect(pricing.getByRole("link", { name: /Connect your server/ })).toHaveAttribute("href", "/sign-up");
  expect(pricing.getByRole("link", { name: /View on GitHub/ })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  expect(pricing.getByText("Start here")).toBeInTheDocument();
  expect(pricing.getByText("Need more room? $19.99 a month for 4 vCPU and 8 GB of RAM.")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/Most popular|not yet available as shown|two months free|\$49|\$99/);
  expect(document.querySelector('a[href^="/dashboard/infrastructure"]')).toBeNull();
});

test("the page answers eight questions and ends on one ask", async () => {
  await renderHome();
  const faq = document.getElementById("faq") as HTMLElement;
  expect(faq.querySelectorAll("details")).toHaveLength(HOMEPAGE_FAQ.length);
  expect(HOMEPAGE_FAQ).toHaveLength(8);
  const closing = within(document.getElementById("start") as HTMLElement);
  expect(closing.getByRole("heading", { level: 2 })).toHaveTextContent("Start with one computer. Make it yours.");
  expect(closing.getByRole("link", { name: /Launch an agent/ })).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(document.querySelector("main")).not.toHaveTextContent(/\$HIVRA|\$HermesOS/);
});

test("app CTA has a real destination and does not manufacture installer availability", () => {
  render(<DownloadPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Hivra on your desktop." })).toBeVisible();
  expect(screen.getByRole("button", { name: /Download for macOS/ })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /Download for Windows/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Hivra in your browser" })).toHaveAttribute("href", "/dashboard");
});
