/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import LandingPage from "@/app/page";
import DownloadPage from "@/app/download/page";
import { AGENTS_SECTION, AGENT_LAUNCH_HREF, CLOSING, HOMEPAGE_FAQ, HOME_AGENTS, PRICING, REACH, SHOW_FOUNDER_SECTION, homepageFaq } from "@/components/landing/home/content";
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

const surfacesBefore = process.env.HIVRA_NEW_TOKEN_SURFACES;
beforeEach(() => {
  mockCount.mockReset();
  mockCount.mockResolvedValue({ total: 2517, asOf: "2026-10-20" });
});
afterEach(() => {
  if (surfacesBefore === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
  else process.env.HIVRA_NEW_TOKEN_SURFACES = surfacesBefore;
});

test("the first screen says what it is, who it is for, and asks once", async () => {
  await renderHome();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your agent needs a computer. It doesn't need yours.");
  expect(screen.getByText((_, element) => element?.tagName === "P" && /^Give Claude Code, Codex or your favourite AI agent a computer of its own\./.test(element.textContent ?? ""))).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.tagName === "P" && /^A paid Hivra Cloud computer stays on and is not paused for inactivity, even when you close your laptop\./.test(element.textContent ?? ""))).toBeInTheDocument();
  expect(document.getElementById("hero-primary-cta")).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(within(document.querySelector("#home-title")?.closest("section") as HTMLElement).getByRole("link", { name: "Start with a computer" })).toHaveAttribute("href", "#computers");
  // The hero makes no price or guarantee claim, and no longer carries the rename link.
  expect(screen.queryByRole("link", { name: /Hermes OS is now Hivra/ })).not.toBeInTheDocument();
  expect(document.querySelector("#home-title")?.closest("section")).not.toHaveTextContent(/\$9\.99|money-back/);
  // The old page's app download and tab switcher are gone.
  expect(screen.queryByRole("link", { name: "Download the app" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

test("the live count links to /stats with its date, and is left out when there is none", async () => {
  await renderHome();
  const stat = screen.getByRole("link", { name: /agents and computers launched on Hivra/ });
  expect(stat).toHaveAttribute("href", "/stats");
  expect(stat).toHaveTextContent("2,517");
  expect(stat).toHaveTextContent("As of 20 October 2026");
  expect(document.body).not.toHaveTextContent("2,034");
});

test.each([null, { total: 0, asOf: "2026-10-20" }])("no count is shown when the lookup gives %p", async snapshot => {
  mockCount.mockResolvedValue(snapshot);
  await renderHome();
  expect(screen.queryByRole("link", { name: /agents and computers launched on Hivra/ })).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/agents and computers launched on Hivra/);
});

test("the reach picture describes the same things its labels show, and the three statements are selectable", async () => {
  await renderHome();
  const picture = document.querySelector('svg[role="img"][aria-label^="Illustration: an agent on your laptop"]');
  expect(picture).not.toBeNull();
  const description = picture?.getAttribute("aria-label") ?? "";
  for (const { label } of REACH.items) expect(description.toLowerCase()).toContain(label.toLowerCase());
  expect(description).not.toMatch(/\bsession\b/i);

  const why = within(document.getElementById("why") as HTMLElement);
  expect(why.getByRole("heading", { level: 2 })).toHaveTextContent("The problem isn't that agents use computers. It's whose computer they're using.");
  expect(why.getByRole("heading", { level: 3 })).toHaveTextContent("Don't make the AI its own guard.");
  const options = within(why.getByRole("list", { name: "Compare the set-ups" }));
  for (const [index, state] of REACH.states.entries()) {
    const button = options.getByRole("button", { name: state.label });
    expect(button).toHaveAttribute("aria-pressed", index === 0 ? "true" : "false");
    expect(button).toHaveAccessibleDescription(state.caption);
    expect(why.getByText(state.caption)).toBeInTheDocument();
  }
  expect(why.getByText(REACH.note)).toBeInTheDocument();
});

test("the comparison is one real table, with Hivra last", async () => {
  await renderHome();
  const fit = within(document.getElementById("fit") as HTMLElement);
  const table = fit.getByRole("table");
  expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toEqual(["Where the agent runs", "Your laptop", "A provider-managed agent", "A typical hosted machine", "Hivra"]);
  expect(within(table).getAllByRole("row")).toHaveLength(7);
  expect(fit.getByRole("link", { name: "Explore the comparisons" })).toHaveAttribute("href", "/compare");
});

test("every section the header and footer link to is still on the page", async () => {
  await renderHome();
  const sectionIds = ["why", "fit", "launch", "agents", "computers", "workspace", "open-source", "pricing", "hosting", "own-server", "faq", "start"];
  if (SHOW_FOUNDER_SECTION) sectionIds.splice(sectionIds.indexOf("faq"), 0, "founder");
  for (const id of sectionIds) {
    expect(document.getElementById(id)).not.toBeNull();
  }
  if (!SHOW_FOUNDER_SECTION) {
    expect(document.getElementById("founder")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Why I'm building Hivra/i })).not.toBeInTheDocument();
  }
});

test("each agent card launches that agent, and computers launch on their own", async () => {
  await renderHome();
  for (const agent of HOME_AGENTS) {
    expect(screen.getByRole("link", { name: `Launch ${agent.name}` })).toHaveAttribute("href", agent.href);
  }
  // The limits show on the cards, so they are seen before the click.
  expect(screen.getByRole("link", { name: "Launch Hermes" })).toHaveTextContent("Hermes runs on Hivra Cloud only.");
  // No card singles out an agent as the paid one: the cost belongs to every Hivra Cloud computer, stated once
  // under the section heading (owner decision, 21 October 2026).
  for (const agent of HOME_AGENTS) expect(screen.getByRole("link", { name: `Launch ${agent.name}` })).not.toHaveTextContent(/paid size|needs a paid/i);
  const agentsSection = within(document.getElementById("launch") as HTMLElement);
  expect(agentsSection.getByText(AGENTS_SECTION.paid)).toBeInTheDocument();
  expect(AGENTS_SECTION.paid).toBe(
    "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.",
  );
  expect(screen.getByRole("link", { name: "Compare supported agents" })).toHaveAttribute("href", "/agents");

  const computers = within(document.getElementById("computers") as HTMLElement);
  expect(computers.getByRole("heading", { level: 3 })).toHaveTextContent("You don't need an agent to use the computer.");
  expect(computers.getByRole("link", { name: /Launch Ubuntu/ })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop");
  expect(computers.getByRole("link", { name: "Explore computers" })).toHaveAttribute("href", "#computers");
  // Neither Omarchy nor Windows is called plainly available: each carries its condition, in the sentence and on its chip.
  expect(computers.getByText(/Ubuntu, Omarchy \(prepared computer\) and Windows on your own server with your licensed image are among the operating-system options/)).toBeInTheDocument();
  expect(computers.queryByText(/\bavailable\b/i)).not.toBeInTheDocument();
  const more = within(computers.getByRole("list", { name: "More computers" }));
  expect(more.getByRole("link", { name: "Windows on your own server with your licensed image" })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=windows");
  expect(more.getByRole("link", { name: "Omarchy (prepared computer)" })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1&profile=omarchy");
  expect(document.querySelector("main")).not.toHaveTextContent(/preview/i);
});

test("the steps are the pack's, and only a tmux run is promised to carry on", async () => {
  await renderHome();
  const how = within(document.getElementById("workspace") as HTMLElement);
  expect(how.getByRole("heading", { level: 2 })).toHaveTextContent("Give it work. Keep the final say.");
  expect(how.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual([
    "Leave it running.",
    "Open the same computer from anywhere.",
    "Choose what it can reach.",
  ]);
  expect(how.getByText((_, element) => element?.tagName === "P" && /a run you start in tmux keeps going\.$/.test(element.textContent ?? ""))).toBeInTheDocument();
  expect(how.getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(how.getByRole("link", { name: "See the plans" })).toHaveAttribute("href", "#pricing");
});

test("the reach limits are drawn wide and on their side, and each chip says where it sits in both", async () => {
  await renderHome();
  const workspace = document.getElementById("workspace") as HTMLElement;
  const boxes = [...workspace.querySelectorAll("svg[viewBox]")].map(svg => svg.getAttribute("viewBox"));
  expect(boxes).toEqual(expect.arrayContaining(["0 0 600 420", "0 0 360 500"]));
  const chips = [...workspace.querySelectorAll<HTMLElement>("li")].filter(li => li.style.getPropertyValue("--lane-y"));
  expect(chips).toHaveLength(6);
  for (const chip of chips) {
    for (const name of ["--lane-y", "--col-x", "--tall-y"]) expect(chip.style.getPropertyValue(name)).toMatch(/^\d+(\.\d+)?%$/);
  }
  // Three allowed across the top row, three blocked across the bottom row, in the same three columns.
  expect(new Set(chips.slice(0, 3).map(chip => chip.style.getPropertyValue("--tall-y"))).size).toBe(1);
  expect(new Set(chips.slice(3).map(chip => chip.style.getPropertyValue("--tall-y"))).size).toBe(1);
  expect(chips.slice(0, 3).map(chip => chip.style.getPropertyValue("--col-x"))).toEqual(chips.slice(3).map(chip => chip.style.getPropertyValue("--col-x")));
});

test("the open source block links the repository and the security page, and types the clone line", async () => {
  await renderHome();
  const open = within(document.getElementById("open-source") as HTMLElement);
  expect(open.getByRole("heading", { level: 2 })).toHaveTextContent("Open source means you don't have to take our word for it.");
  expect(open.getByRole("link", { name: /View Hivra on GitHub/ })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  expect(open.getByRole("link", { name: "Read the security information" })).toHaveAttribute("href", "/security");
  expect(open.getAllByText("git clone https://github.com/ashneil12/hivra").length).toBeGreaterThan(0);
  expect(open.queryByRole("link", { name: /litepaper|commitment/i })).not.toBeInTheDocument();
});

test("pricing shows the four offers that can be had today and links straight to checkout", async () => {
  await renderHome();
  const pricing = within(document.getElementById("pricing") as HTMLElement);
  expect(pricing.getAllByRole("article")).toHaveLength(4);
  expect(pricing.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(["Hivra Cloud", "More room", "Connect your server", "Self-host the platform"]);
  expect(pricing.getByRole("heading", { level: 2 })).toHaveTextContent("Start free on your own server. Or let us run it from $9.99 a month.");
  expect(pricing.getByRole("link", { name: /Get started/ })).toHaveAttribute("href", "/get-started?plan=operator");
  expect(pricing.getByRole("link", { name: /Choose this size/ })).toHaveAttribute("href", "/get-started?plan=fleet");
  expect(pricing.getByRole("link", { name: /Connect a server/ })).toHaveAttribute("href", "/sign-up");
  expect(pricing.getByRole("link", { name: /See the repository/ })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  expect(pricing.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
  expect(pricing.getByRole("link", { name: /Full pricing and what's included/ })).toHaveAttribute("href", "/pricing");
  const more = within(pricing.getByRole("article", { name: "More room" }));
  expect(more.getByText("4 vCPU and 8 GB of RAM")).toBeInTheDocument();
  expect(pricing.getByText(PRICING.aiUsage, { exact: false })).toHaveTextContent(`Hosted plans carry a ${MONEY_BACK_GUARANTEE}, subject to the terms.`);
  expect(document.body).not.toHaveTextContent(/Most popular|Start here|not yet available as shown|two months free|\$49|\$99|Starter|Power/);
  expect(document.querySelector('a[href^="/dashboard/infrastructure"]')).toBeNull();
});

test("the page answers seven questions and ends on one ask", async () => {
  await renderHome();
  const faq = document.getElementById("faq") as HTMLElement;
  expect(within(faq).getByRole("heading", { level: 2 })).toHaveTextContent("A few questions, answered.");
  expect(faq.querySelectorAll("details")).toHaveLength(HOMEPAGE_FAQ.length);
  expect(HOMEPAGE_FAQ).toHaveLength(7);
  const closing = within(document.getElementById("start") as HTMLElement);
  expect(closing.getByRole("heading", { level: 2 })).toHaveTextContent("Start with one computer.");
  expect(document.getElementById("start")).toHaveTextContent("Give it a project, see what it can do and keep the rest of your life outside its workspace.");
  // The closing ask carries the same rule in the same words, so nobody reaches "Launch an agent" expecting a free computer.
  expect(within(document.getElementById("start") as HTMLElement).getByText(CLOSING.paid)).toBeInTheDocument();
  expect(closing.getByRole("link", { name: /Launch an agent/ })).toHaveAttribute("href", AGENT_LAUNCH_HREF);
  expect(closing.getByRole("link", { name: /Start with a computer/ })).toHaveAttribute("href", "#computers");
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
