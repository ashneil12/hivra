/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import LandingPage from "@/app/page";
import DownloadPage from "@/app/download/page";
import { AGENTS_SECTION, AGENT_LAUNCH_HREF, CLOSING, HOMEPAGE_FAQ, HOME_AGENTS, PRICING, SHOW_FOUNDER_SECTION, STEPS, homepageFaq } from "@/components/landing/home/content";
import { MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";

jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
jest.mock("@/components/public-site/PublicSite", () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));

// The live count is read on the server and cached; the page test hands it in.
const mockCount = jest.fn();
jest.mock("@/components/landing/home/agents-deployed", () => ({ getHomeAgentsDeployed: () => mockCount() }));

async function renderHome() {
  return render(await LandingPage({}));
}

// jsdom has no matchMedia; the hero's ThinkingOrb reads the reduced-motion preference.
beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof window.matchMedia;
  }
});

const surfacesBefore = process.env.HIVRA_NEW_TOKEN_SURFACES;
beforeEach(() => {
  mockCount.mockReset();
  mockCount.mockResolvedValue({ total: 2517, asOf: "2026-10-20" });
});
afterEach(() => {
  if (surfacesBefore === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
  else process.env.HIVRA_NEW_TOKEN_SURFACES = surfacesBefore;
});

test("the first screen says what it is and asks once", async () => {
  await renderHome();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Give your AI agent a computer of its own.");
  expect(screen.getByText((_, element) => element?.tagName === "P" && /^Research, code, automate and get work done without running an agent on your own computer\./.test(element.textContent ?? ""))).toBeInTheDocument();
  expect(document.getElementById("hero-primary-cta")).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  const hero = within(document.querySelector("#home-title")?.closest("section") as HTMLElement);
  expect(hero.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "#pricing");
  expect(hero.getByText("Free on your own server")).toBeInTheDocument();
  expect(hero.getByText("7-day money-back guarantee")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Hermes OS is now Hivra/ })).not.toBeInTheDocument();
  expect(document.querySelector("#home-title")?.closest("section")).not.toHaveTextContent(/\$9\.99/);
  expect(screen.queryByRole("link", { name: "Download the app" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

test("the hero shows the live count with its date when the page has one", async () => {
  await renderHome();
  const stat = screen.getByRole("link", { name: /agents and computers launched on Hivra/ });
  expect(stat).toHaveAttribute("href", "/stats");
  expect(stat).toHaveTextContent("2,517");
  expect(stat).toHaveTextContent("As of 20 October 2026");
});

test("no count shows when the lookup fails", async () => {
  mockCount.mockResolvedValue(null);
  await renderHome();
  expect(screen.queryByRole("link", { name: /agents and computers launched on Hivra/ })).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/agents and computers launched on Hivra/);
});

test("the page is short: hero, agents, three steps, pricing, questions and one closing ask", async () => {
  await renderHome();
  const headings = Array.from(document.querySelectorAll("main h2")).map(node => node.textContent);
  expect(headings).toEqual([
    "Your agent needs computer access. It doesn't need your computer.",
    "Choose what you want done. We'll give the agent a computer.",
    "Three steps. Then it gets to work.",
    "Use Hivra Cloud, or run it on your own server. Hosted plans start at $9.99 a month.",
    "Questions.",
    "Give your agent a computer of its own.",
  ]);
  // The long story lives on its own pages now.
  for (const id of ["why", "fit", "workspace", "open-source"]) expect(document.getElementById(id)).toBeNull();
});

test("every section the header and footer link to is still on the page", async () => {
  await renderHome();
  const sectionIds = ["launch", "agents", "computers", "how", "pricing", "hosting", "own-server", "faq", "start"];
  for (const id of sectionIds) {
    expect(document.getElementById(id)).not.toBeNull();
  }
  if (!SHOW_FOUNDER_SECTION) {
    expect(document.getElementById("founder")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Why I'm building Hivra/i })).not.toBeInTheDocument();
  }
});

test("each agent card launches that agent, and a computer launches on its own", async () => {
  await renderHome();
  for (const agent of HOME_AGENTS) {
    expect(screen.getByRole("link", { name: `Launch ${agent.name}` })).toHaveAttribute("href", agent.href);
  }
  expect(screen.getByRole("link", { name: "Launch Hermes" })).toHaveTextContent("Hermes runs on Hivra Cloud only.");
  for (const agent of HOME_AGENTS) expect(screen.getByRole("link", { name: `Launch ${agent.name}` })).not.toHaveTextContent(/paid size|needs a paid/i);
  const agentsSection = within(document.getElementById("launch") as HTMLElement);
  expect(agentsSection.getByText(AGENTS_SECTION.paid)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Compare agents" })).toHaveAttribute("href", "/agents");

  const computers = within(document.getElementById("computers") as HTMLElement);
  expect(computers.getByRole("link", { name: /Launch Ubuntu/ })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  expect(document.querySelector("main")).not.toHaveTextContent(/preview/i);
});

test("the three steps go from picking an agent to chatting with it", async () => {
  await renderHome();
  const how = within(document.getElementById("how") as HTMLElement);
  expect(how.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(STEPS.steps.map(step => step.title));
  expect(how.getAllByRole("listitem")).toHaveLength(3);
});

test("pricing shows the three offers that can be had today and links straight to checkout", async () => {
  await renderHome();
  const pricing = within(document.getElementById("pricing") as HTMLElement);
  expect(pricing.getAllByRole("article")).toHaveLength(3);
  expect(pricing.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(["Hivra Cloud", "More room", "Your own server"]);
  expect(pricing.getByRole("link", { name: /Get started/ })).toHaveAttribute("href", "/get-started?plan=operator");
  expect(pricing.getByRole("link", { name: /Choose this size/ })).toHaveAttribute("href", "/get-started?plan=fleet");
  expect(pricing.getByRole("link", { name: /Sign up free/ })).toHaveAttribute("href", "/sign-up");
  expect(pricing.getByRole("link", { name: /Self-host from GitHub/ })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  expect(pricing.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
  expect(pricing.getByRole("link", { name: "Full pricing" })).toHaveAttribute("href", "/pricing");
  const more = within(pricing.getByRole("article", { name: "More room" }));
  expect(more.getByText("4 vCPU and 8 GB of RAM")).toBeInTheDocument();
  expect(pricing.getByText(PRICING.aiUsage, { exact: false })).toHaveTextContent(`Hosted plans carry a ${MONEY_BACK_GUARANTEE}, subject to the terms.`);
  expect(document.body).not.toHaveTextContent(/Most popular|Start here|not yet available as shown|two months free|\$49|\$99|Starter|Power/);
  expect(document.querySelector('a[href^="/dashboard/infrastructure"]')).toBeNull();
});

test("the page answers its questions and ends on one ask", async () => {
  await renderHome();
  const faq = document.getElementById("faq") as HTMLElement;
  expect(within(faq).getByRole("heading", { level: 2 })).toHaveTextContent("Questions.");
  expect(faq.querySelectorAll("details")).toHaveLength(HOMEPAGE_FAQ.length);
  const closing = within(document.getElementById("start") as HTMLElement);
  expect(closing.getByRole("heading", { level: 2 })).toHaveTextContent("Give your agent a computer of its own.");
  expect(closing.getByText(CLOSING.paid)).toBeInTheDocument();
  expect(closing.getByRole("link", { name: /Launch an agent/ })).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(closing.getByRole("button", { name: /Motion/ })).toBeInTheDocument();
  expect(document.querySelector("main")).not.toHaveTextContent(/\$HIVRA|\$HermesOS/);
});

test("the token sentence shows only while the token surfaces are visible to this viewer", async () => {
  process.env.HIVRA_NEW_TOKEN_SURFACES = "true";
  const on = await renderHome();
  expect(on.container).toHaveTextContent("Token-related access and future plans are explained separately.");
  on.unmount();

  process.env.HIVRA_NEW_TOKEN_SURFACES = "false";
  const off = await renderHome();
  expect(off.container).not.toHaveTextContent(/Token-related access/);
  const answers = Array.from(off.container.querySelectorAll("#faq details p")).map(node => node.textContent);
  expect(answers).toEqual(homepageFaq(false).map(({ a }) => a));
});

test("app CTA has a real destination and does not manufacture installer availability", () => {
  render(<DownloadPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Hivra on your computer." })).toBeVisible();
  expect(screen.getByRole("button", { name: /Download for macOS/ })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /Download for Windows/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Hivra" })).toHaveAttribute("href", "/dashboard");
});
