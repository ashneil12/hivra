/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Hero from "../Hero";
import Pricing from "../Pricing";
import Faq from "../Faq";
import { HOMEPAGE_FAQ } from "../content";

const HIDDEN = /style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/;

test("the hero copy and call to action ship visible, before any script runs", () => {
  const markup = renderToStaticMarkup(<Hero />);
  const copy = markup.slice(0, markup.indexOf("Illustration"));
  expect(copy).toContain("Your agent needs a");
  expect(copy).toContain("Launch an agent");
  expect(copy).toContain("7-day money-back guarantee on card payments.");
  // Only the illustration may start hidden and animate in; the words never do.
  const beforeScene = copy.slice(0, copy.indexOf("Your Claude or ChatGPT login"));
  expect(beforeScene).not.toMatch(HIDDEN);
});

test("pricing ships complete and visible in server HTML", () => {
  const markup = renderToStaticMarkup(<Pricing />);
  expect(markup.match(/<article\b/g)).toHaveLength(3);
  for (const text of ["$9.99", "2 vCPU and 4 GB of RAM", "$19.99 a month for 4 vCPU and 8 GB of RAM", "$0", "Start here", "/get-started?plan=operator", "/get-started?plan=fleet"]) {
    expect(markup).toContain(text);
  }
  expect(markup).not.toMatch(HIDDEN);
});

test("every answer is in the server HTML, with the first one open", () => {
  const markup = renderToStaticMarkup(<Faq />);
  expect(markup.match(/<details\b/g)).toHaveLength(HOMEPAGE_FAQ.length);
  expect(markup.match(/<details[^>]*\bopen\b/g)).toHaveLength(1);
  for (const { a } of HOMEPAGE_FAQ) expect(markup).toContain(a.replace(/'/g, "&#x27;"));
});
