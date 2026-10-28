/** @jest-environment node */
import { renderToStaticMarkup } from "react-dom/server";
import Hero from "../Hero";
import Pricing from "../Pricing";
import Faq from "../Faq";
import Fit from "../Fit";
import Reach from "../Reach";
import { HomeMotion } from "../motion";
import { FIT, HOMEPAGE_FAQ, PRICING, REACH, homepageFaq } from "../content";
import { findBannedClaims } from "@/lib/tools/copy-rules";

/** What a reader sees: tags removed, entities decoded. */
const readable = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const HIDDEN = /style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/;

test("the hero copy and call to action ship visible, before any script runs", () => {
  const markup = renderToStaticMarkup(<Hero />);
  const copy = markup.slice(0, markup.indexOf("Illustration"));
  expect(copy).toContain("Your agent needs a");
  expect(copy).toContain("Launch an agent");
  expect(copy).toContain("Start with a computer");
  // Both subhead paragraphs are in the first screen.
  expect(readable(copy)).toContain("Give Claude Code, Codex or your favourite AI agent a computer of its own.");
  expect(readable(copy)).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity, even when you close your laptop.");
  // Only the illustration may start hidden and animate in; the words never do.
  const beforeScene = copy.slice(0, copy.indexOf("Use your own Claude or ChatGPT login"));
  expect(beforeScene.length).toBeGreaterThan(0);
  expect(beforeScene).not.toMatch(HIDDEN);
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

test("pricing ships four offers complete and visible in server HTML", () => {
  const markup = renderToStaticMarkup(<Pricing />);
  expect(markup.match(/<article\b/g)).toHaveLength(4);
  const text = readable(markup);
  for (const expected of [
    "Hivra Cloud",
    "$9.99",
    "2 vCPU and 4 GB of RAM",
    "More room",
    "$19.99",
    "4 vCPU and 8 GB of RAM",
    "Connect your server",
    "Self-host the platform",
    "$0",
    "software cost",
    "Full pricing and what's included",
  ]) {
    expect(text).toContain(expected);
  }
  for (const href of ["/get-started?plan=operator", "/get-started?plan=fleet", "/sign-up", "/pricing", "/terms"]) expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain('id="hosting"');
  expect(markup).toContain('id="own-server"');
  expect(markup).not.toMatch(HIDDEN);
  // The price of each size sits with its size in one sentence (lib/tools/copy-rules.ts).
  expect(findBannedClaims(text).filter(hit => !/Windows/.test(hit.why))).toEqual([]);
  expect(text).toContain(PRICING.aiUsage);
  expect(text).toContain("Hosted plans carry a 7-day money-back guarantee on card payments, subject to the terms.");
  expect(text).not.toContain("Start here");
});

test("every answer is in the server HTML, with the first one open", () => {
  const markup = renderToStaticMarkup(<Faq />);
  expect(markup.match(/<details\b/g)).toHaveLength(HOMEPAGE_FAQ.length);
  expect(markup.match(/<details[^>]*\bopen\b/g)).toHaveLength(1);
  for (const { a } of HOMEPAGE_FAQ) expect(readable(markup)).toContain(a);
});

test("the question list is titled as the website pack titles it", () => {
  const markup = renderToStaticMarkup(<Faq />);
  expect(markup).toContain(">A few questions, answered.</h2>");
  expect(markup).not.toContain("Common questions");
});

test("the token sentence is in the answer only for the list the page hands in", () => {
  expect(readable(renderToStaticMarkup(<Faq items={homepageFaq(false)} />))).not.toContain("Token-related access");
  expect(readable(renderToStaticMarkup(<Faq items={homepageFaq(true)} />))).toContain("Token-related access and future plans are explained separately.");
});

test("the comparison ships complete in server HTML as a real table with a label on every cell", () => {
  const markup = renderToStaticMarkup(<Fit />);
  expect(markup.match(/<tbody[^>]*>[\s\S]*<\/tbody>/)?.[0].match(/<tr\b/g)).toHaveLength(FIT.rows.length);
  for (const column of FIT.columns) expect(markup).toContain(`data-label="${column}"`);
  expect(markup.match(/<td[^>]*data-label=/g)).toHaveLength(FIT.rows.length * FIT.columns.length);
  expect(markup).toContain('scope="row"');
  expect(readable(markup)).toContain(FIT.rowHeading);
  for (const cell of FIT.rows.flatMap(row => row.cells)) expect(readable(markup)).toContain(cell);
  expect(readable(markup)).toContain(FIT.note);
  expect(markup).toContain('href="/compare"');
  // A mark is decoration; the word beside it is always in the text.
  const marked = FIT.rows.flatMap(row => row.cells).filter(cell => cell === "Yes" || cell === "No").length;
  expect(markup.match(/<i[^>]*aria-hidden="true"[^>]*><\/i>(Yes|No)</g)).toHaveLength(marked);
  expect(markup).not.toMatch(HIDDEN);
});

test("the problem is ordinary page text, with the pinned scene's short text after it", () => {
  const markup = renderToStaticMarkup(<Reach />);
  const text = readable(markup);
  expect(markup.match(/<h2\b/g)).toHaveLength(1);
  expect(markup.match(/<h3\b/g)).toHaveLength(1);
  for (const paragraph of REACH.intro.body) expect(text).toContain(paragraph);
  expect(text).toContain(REACH.intro.pull);
  expect(text.indexOf(REACH.intro.body[0])).toBeLessThan(text.indexOf(REACH.titleB));
  for (const paragraph of REACH.bodyB) expect(text).toContain(paragraph);
  // All three statements of the interactive are in the HTML at once, whichever is playing.
  for (const state of REACH.states) {
    expect(text).toContain(state.label);
    expect(text).toContain(state.caption);
  }
  expect(text).toContain(REACH.note);
});

test("every hero proof point has an icon, under the same motion wrapper the page uses", () => {
  const html = renderToStaticMarkup(
    <HomeMotion>
      <Hero />
    </HomeMotion>
  );
  for (const point of require("../content").HERO.proof as readonly string[]) {
    expect(readable(html)).toContain(point.split(".")[0]);
  }
});
