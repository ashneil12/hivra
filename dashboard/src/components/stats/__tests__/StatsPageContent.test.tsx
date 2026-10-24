/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import type { PublicStats } from "@/lib/public-stats";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import StatsPageContent from "../StatsPageContent.client";
import { hasDeployedCount } from "../stats-parts.client";

// Motion props are irrelevant here; render plain elements.
jest.mock("framer-motion", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const strip = (tag: string) =>
    react.forwardRef(function MotionElement(props: Record<string, unknown>, ref) {
      const rest = { ...props };
      for (const key of ["initial", "animate", "exit", "transition", "whileInView", "viewport", "layout"]) delete rest[key];
      return react.createElement(tag, { ...rest, ref });
    });
  return {
    motion: new Proxy({}, { get: (_target, tag) => strip(String(tag)) }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => react.createElement(react.Fragment, null, children),
    useReducedMotion: () => true,
  };
});

const SHOWN = { tokenSurfaces: true, geoBlocked: false };
const HIDDEN = { tokenSurfaces: false, geoBlocked: false };

const GENERATED_AT = "2026-10-20T14:05:00.000Z";
const LIVE = {
  total: 1234,
  last24h: 7,
  last7d: 41,
  series: [
    { date: "2026-10-18", count: 1200 },
    { date: "2026-10-19", count: 1210 },
    { date: "2026-10-20", count: 1234 },
  ],
  generatedAt: GENERATED_AT,
};
// What getAgentsDeployedStats() hands back when its lookup fails.
const FAILED = { total: 0, last24h: 0, last7d: 0, generatedAt: GENERATED_AT };

function platformStats(overrides: Partial<PublicStats> = {}): PublicStats {
  return {
    generatedAt: GENERATED_AT,
    agentsDeployed: 1234,
    runningNow: 18,
    builders: 0,
    tokensProcessed: 0,
    tokensAnchorPrev: null,
    tokensAnchorPrevAt: null,
    tokensAnchorCurr: null,
    tokensAnchorCurrAt: null,
    countries: 0,
    models: 0,
    providers: 0,
    last7dDeployed: 0,
    ...overrides,
  };
}

function renderStats(props: Partial<React.ComponentProps<typeof StatsPageContent>> = {}, locale: "en" | "zh-CN" = "en") {
  return render(
    <LocaleProvider initialLocale={locale}>
      <StatsPageContent
        initial={LIVE}
        firstDeployIso="2026-03-02T09:00:00.000Z"
        platform={platformStats()}
        tokenView={HIDDEN}
        {...props}
      />
    </LocaleProvider>,
  );
}

describe("/stats content", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // The live polls fail quietly: the page keeps the figures it was given.
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("opens with the md heading and introduction under one h1", () => {
    renderStats();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Hivra in numbers." })).toBeInTheDocument();
    expect(
      screen.getByText(
        "It’s useful to see what people are actually building and running. This page brings together the platform statistics we can measure, with enough context to understand what each number means.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the live deployed total, dated, with the definition under it", () => {
    renderStats();
    const section = screen.getByRole("region", { name: "Agents and computers launched" });
    expect(within(section).getByLabelText("1,234 agents and computers launched all-time")).toBeInTheDocument();
    expect(within(section).getByText(/^As of/)).toHaveTextContent("As of 20 October 2026 at 14:05 UTC");
    expect(within(section).getByText(/^As of/).querySelector("time")).toHaveAttribute("datetime", GENERATED_AT);
    expect(section).toHaveTextContent(
      "A launch is an agent or a computer that was created and came up successfully at least once, not necessarily a unique user, one currently online or a paying subscription.",
    );
    expect(section).toHaveTextContent("We keep those measures separate so the number isn’t mistaken for something it doesn’t represent.");
  });

  it("hides the number when the lookup failed, and keeps the definition", () => {
    renderStats({ initial: FAILED, firstDeployIso: null, platform: null });
    const section = screen.getByRole("region", { name: "Agents and computers launched" });
    expect(within(section).queryByLabelText(/agents and computers launched all-time/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/^As of/)).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent(/\b0\b/);
    expect(within(section).getByRole("status")).toHaveTextContent("The count could not be loaded just now.");
    expect(section).toHaveTextContent("A launch is an agent or a computer that was created");
    // Nothing else is available either, so there is nothing to introduce.
    expect(screen.queryByRole("heading", { name: "More ways to understand activity" })).not.toBeInTheDocument();
  });

  it("hides the number when there is no data at all", () => {
    renderStats({ initial: null, firstDeployIso: null, platform: null });
    expect(screen.getByRole("status")).toHaveTextContent("The count could not be loaded just now.");
  });

  it("describes only the figures that are on the page", () => {
    renderStats({ platform: null });
    const more = screen.getByRole("region", { name: "More ways to understand activity" });
    expect(more).toHaveTextContent(
      "Alongside the total, this page shows how many were launched in the last 24 hours and the last 7 days, the date of the first launch and a 30-day chart of the running total.",
    );
    expect(more).not.toHaveTextContent(/(?:live|running) right now/);
    expect(more).not.toHaveTextContent(/frameworks/i);
    expect(more).not.toHaveTextContent(/tokens processed/i);
    expect(screen.queryByText("Agents and computers running now")).not.toBeInTheDocument();
  });

  it("names the 30-day chart in the page's own launch wording", () => {
    renderStats({ platform: null });
    expect(screen.getByRole("heading", { level: 3, name: "Launches, last 30 days" })).toBeInTheDocument();
    expect(screen.queryByText(/^Deploys, last 30 days$/)).not.toBeInTheDocument();
  });

  it("adds the live count and the tokens figure to the sentence when they exist", () => {
    renderStats({ platform: platformStats({ tokensProcessed: 5_000_000, models: 3, providers: 2 }) });
    const more = screen.getByRole("region", { name: "More ways to understand activity" });
    expect(more).toHaveTextContent(
      "Alongside the total, this page shows how many agents and computers are running right now, how many were launched in the last 24 hours and the last 7 days, the date of the first launch, a 30-day chart of the running total and the tokens processed across the platform.",
    );
    expect(within(more).getByText("Agents and computers running now")).toBeInTheDocument();
    expect(within(more).getByText("Tokens processed")).toBeInTheDocument();
    expect(within(more).getByText(/across 3 models/)).toBeInTheDocument();
  });

  it("does not say 'alongside the total' when the total could not be loaded", () => {
    renderStats({ initial: FAILED, firstDeployIso: "2026-03-02T09:00:00.000Z", platform: platformStats() });
    const more = screen.getByRole("region", { name: "More ways to understand activity" });
    expect(more).toHaveTextContent(
      "This page also shows how many agents and computers are running right now and the date of the first launch.",
    );
    expect(more).not.toHaveTextContent(/alongside the total/i);
    // The page still has its landmark and the failure line in the deployed section.
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("status")).toHaveTextContent("The count could not be loaded just now.");
  });

  it("labels the running figure for what it counts: agents and computers, not paid use", () => {
    const { container } = renderStats({ platform: platformStats({ runningNow: 18 }) });
    const more = screen.getByRole("region", { name: "More ways to understand activity" });
    expect(within(more).getByText("Agents and computers running now")).toBeInTheDocument();
    expect(within(more).getByText("18")).toBeInTheDocument();
    // The count is every agent and computer in a running state, so it never says "live" or implies a paid plan.
    expect(container.textContent).not.toMatch(/agents live now|live right now/i);
  });

  it("labels the running figure on the translated page the same way", () => {
    renderStats({ platform: platformStats({ runningNow: 18 }) }, "zh-CN");
    expect(screen.getByText("Agents and computers running now")).toBeInTheDocument();
    expect(screen.getByLabelText("18 agents and computers running now")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/agents live now/i);
  });

  it("makes no promise the page cannot keep about guessed figures or where figures come from", () => {
    const { container } = renderStats({ tokenView: SHOWN });
    const text = container.textContent ?? "";
    // The odometer no longer flickers (TokenOdometer.test.tsx), but it still plays the figure between two hourly
    // checkpoints, about an hour behind, so "we won't publish guessed figures" stays out until Ash decides.
    expect(text).not.toMatch(/guessed/i);
    expect(text).not.toMatch(/telemetry/i);
  });

  it("shows the token trading volume sentence only when the token surfaces are visible", () => {
    const sentence = "We won’t treat token trading volume as evidence of actual product use.";
    const { container, unmount } = renderStats({ tokenView: HIDDEN });
    expect(container.textContent).not.toContain("trading volume");
    expect(container.textContent).not.toMatch(/token/i);
    unmount();

    const shown = renderStats({ tokenView: SHOWN });
    expect(shown.container.textContent).toContain(sentence);
    shown.unmount();

    renderStats({ tokenView: { tokenSurfaces: true, geoBlocked: true } });
    expect(document.body.textContent).not.toContain("trading volume");
  });

  it("closes with the two md links", () => {
    renderStats();
    expect(screen.getByRole("link", { name: "Explore agents" })).toHaveAttribute("href", "/agents");
    expect(screen.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.queryByRole("link", { name: /deploy your agent/i })).not.toBeInTheDocument();
  });

  it("writes no dash, no retired claim and no banned vocabulary", () => {
    const { container } = renderStats({ platform: platformStats({ tokensProcessed: 5_000_000, models: 3, providers: 2 }), tokenView: SHOWN });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/\binstances?\b/i);
    expect(findBannedClaims(text)).toEqual([]);
  });

  it("keeps the translated page for a visitor browsing in another language", () => {
    renderStats({}, "zh-CN");
    expect(screen.queryByRole("heading", { name: "Hivra in numbers." })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("在 Hivra 上");
    expect(screen.queryByRole("link", { name: "Explore agents" })).not.toBeInTheDocument();
  });

  it("shows no false zero in the translated page when the lookup failed", () => {
    renderStats({ initial: FAILED, firstDeployIso: null, platform: null }, "zh-CN");
    expect(screen.queryByLabelText(/^0 /)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+0\b/);
  });
});

describe("hasDeployedCount", () => {
  it("reads an all-zero answer as a failed lookup, not a count", () => {
    expect(hasDeployedCount(null)).toBe(false);
    expect(hasDeployedCount({ total: 0, last24h: 0, last7d: 0 })).toBe(false);
    expect(hasDeployedCount({ total: Number.NaN, last24h: 0, last7d: 0 })).toBe(false);
    expect(hasDeployedCount({ total: 1, last24h: 0, last7d: 0 })).toBe(true);
    expect(hasDeployedCount({ total: 0, last24h: 1, last7d: 1 })).toBe(true);
  });
});
