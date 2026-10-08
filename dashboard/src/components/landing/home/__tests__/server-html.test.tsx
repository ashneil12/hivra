/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Hero from "../Hero";
import Pricing from "../Pricing";
import Faq from "../Faq";
import Fit from "../Fit";
import { FIT, HOMEPAGE_FAQ } from "../content";

/** What a reader sees: tooltip spans removed, entities decoded. */
const readable = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const HIDDEN = /style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/;

test("the hero copy and call to action ship visible, before any script runs", () => {
  const markup = renderToStaticMarkup(<Hero />);
  const copy = markup.slice(0, markup.indexOf("Illustration"));
  expect(copy).toContain("Your agent needs a");
  expect(copy).toContain("Launch an agent");
  // Only the illustration may start hidden and animate in; the words never do.
  const beforeScene = copy.slice(0, copy.indexOf("Your own Claude or ChatGPT account"));
  expect(beforeScene).not.toMatch(HIDDEN);
});

test("pricing ships complete and visible in server HTML", () => {
  const markup = renderToStaticMarkup(<Pricing />);
  expect(markup.match(/<article\b/g)).toHaveLength(3);
  for (const text of ["$9.99", "2 vCPU and 4 GB of RAM", "$19.99 a month for 4 vCPU and 8 GB of RAM", "$0", "Start here"]) {
    expect(readable(markup)).toContain(text);
  }
  for (const href of ["/get-started?plan=operator", "/get-started?plan=fleet"]) expect(markup).toContain(href);
  expect(markup).not.toMatch(HIDDEN);
});

test("every answer is in the server HTML, with the first one open", () => {
  const markup = renderToStaticMarkup(<Faq />);
  expect(markup.match(/<details\b/g)).toHaveLength(HOMEPAGE_FAQ.length);
  expect(markup.match(/<details[^>]*\bopen\b/g)).toHaveLength(1);
  for (const { a } of HOMEPAGE_FAQ) expect(readable(markup)).toContain(a);
});

test("the comparison ships complete in server HTML, with words behind every mark", () => {
  const markup = renderToStaticMarkup(<Fit />);
  expect(markup.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr\b/g)).toHaveLength(FIT.rows.length);
  for (const column of FIT.columns) expect(markup).toContain(`${column.replace(/'/g, "&#x27;")}<small>`);
  // Marks are decoration; each Yes and No is still in the text a screen reader reads.
  const marked = FIT.rows.flatMap(row => row.cells).filter(cell => cell === "Yes" || cell === "No").length;
  expect(markup.match(/<i[^>]*aria-hidden="true"[^>]*><\/i><span[^>]*>(Yes|No)<\/span>/g)).toHaveLength(marked);
  expect(markup).not.toMatch(HIDDEN);
});
