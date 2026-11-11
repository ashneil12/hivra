/** @jest-environment node */
import { renderToStaticMarkup } from "react-dom/server";
import Hero from "../Hero";
import Pricing from "../Pricing";
import Faq from "../Faq";
import Steps from "../Steps";
import { HomeMotion } from "../motion";
import { HOMEPAGE_FAQ, PRICING, STEPS, homepageFaq } from "../content";
import { findBannedClaims } from "@/lib/tools/copy-rules";

/** What a reader sees: tags removed, entities decoded. */
const readable = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const HIDDEN = /style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/;

test("the hero copy and call to action ship visible, before any script runs", () => {
  const markup = renderToStaticMarkup(<Hero />);
  // The words end with the proof list; the illustration after it may animate in.
  const copy = markup.slice(0, markup.indexOf("</ul>"));
  expect(readable(copy)).toContain("Launch an AI agent.");
  expect(copy).toContain("Launch an agent");
  expect(copy).toContain("See pricing");
  expect(readable(copy)).toContain("Pick Claude Code, Codex, Hermes or another agent.");
  // Only the illustration may start hidden and animate in; the words never do.
  expect(copy.length).toBeGreaterThan(0);
  expect(copy).not.toMatch(HIDDEN);
});

test("the live count shows in the hero only when the page has one, with its date and a link to /stats", () => {
  expect(readable(renderToStaticMarkup(<Hero />))).not.toContain("agents and computers launched on Hivra");
  expect(readable(renderToStaticMarkup(<Hero agentsDeployed={null} />))).not.toContain("agents and computers launched on Hivra");

  const markup = renderToStaticMarkup(<Hero agentsDeployed={{ total: 2517, asOf: "2026-10-20" }} />);
  expect(markup).toContain('href="/stats"');
  expect(readable(markup)).toContain("2,517");
  expect(readable(markup)).toContain("agents and computers launched on Hivra");
  expect(readable(markup)).toContain("As of 20 October 2026");
  // The count is part of the first screen's words: nothing before the end of it starts hidden.
  expect(markup.slice(0, markup.indexOf("Full stats"))).not.toMatch(HIDDEN);
});

test("pricing ships three offers complete and visible in server HTML", () => {
  const markup = renderToStaticMarkup(<Pricing />);
  expect(markup.match(/<article\b/g)).toHaveLength(3);
  const text = readable(markup);
  for (const expected of ["Free", "$0", "Hivra Cloud", "$9.99", "2 vCPU and 4 GB of RAM", "More room", "$19.99", "4 vCPU and 8 GB of RAM", "Self-host from GitHub", "Full pricing"]) {
    expect(text).toContain(expected);
  }
  for (const href of ["/get-started?plan=operator", "/get-started?plan=fleet", "/sign-up", "/pricing", "/terms", "https://github.com/ashneil12/hivra"]) expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain('id="hosting"');
  expect(markup).toContain('id="own-server"');
  expect(markup).not.toMatch(HIDDEN);
  // The price of each size sits with its size in one sentence (lib/tools/copy-rules.ts).
  expect(findBannedClaims(text)).toEqual([]);
  expect(text).toContain(PRICING.aiUsage);
  expect(text).toContain("Hosted plans carry a 7-day money-back guarantee on card payments, subject to the terms.");
  expect(text).not.toContain("Start here");
});

test("every answer is in the server HTML, all closed so the list stays short", () => {
  const markup = renderToStaticMarkup(<Faq />);
  expect(markup.match(/<details\b/g)).toHaveLength(HOMEPAGE_FAQ.length);
  expect(markup.match(/<details[^>]*\bopen\b/g)).toBeNull();
  for (const { a } of HOMEPAGE_FAQ) expect(readable(markup)).toContain(a);
});

test("the question list has a one-word title", () => {
  expect(renderToStaticMarkup(<Faq />)).toContain(">Questions.</h2>");
});

test("the token sentence is in the answer only for the list the page hands in", () => {
  expect(readable(renderToStaticMarkup(<Faq items={homepageFaq(false)} />))).not.toContain("Token-related access");
  expect(readable(renderToStaticMarkup(<Faq items={homepageFaq(true)} />))).toContain("Token-related access and future plans are explained separately.");
});

test("the three steps ship complete and visible in server HTML", () => {
  const markup = renderToStaticMarkup(<Steps />);
  expect(markup.match(/<li\b/g)).toHaveLength(3);
  for (const step of STEPS.steps) {
    expect(readable(markup)).toContain(step.title);
    expect(readable(markup)).toContain(step.body);
  }
  expect(markup).not.toMatch(HIDDEN);
});

test("every hero proof point has an icon, under the same motion wrapper the page uses", () => {
  const html = renderToStaticMarkup(
    <HomeMotion>
      <Hero />
    </HomeMotion>
  );
  for (const point of require("../content").HERO.proof as readonly string[]) {
    expect(readable(html)).toContain(point);
  }
});
