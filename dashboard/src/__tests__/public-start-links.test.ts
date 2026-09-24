/** @jest-environment node */
// FTUE-16: public "start" links sent people to a plan page first. Register
// and every "Start free" link opened /get-started?plan=free, and generic
// "Deploy Now" links opened /get-started?plan=operator, which starts Pro
// checkout right after sign-up, before someone bringing their own server had
// even chosen where to run. Now they all go to sign-up, which lands in Launch;
// Launch turns Free on, with its own button, only for a launch on Hivra Cloud.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { PUBLIC_START_HREF } from "@/lib/public-start";

const redirectMock = jest.fn();
jest.mock("next/navigation", () => ({ redirect: (href: string) => redirectMock(href) }));

const ROOT = path.resolve(__dirname, "..");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("public start links", () => {
  it("go to sign-up, which lands in Launch", () => {
    expect(PUBLIC_START_HREF).toBe("/sign-up");
  });

  it("never send someone to a plan page from a page or component", () => {
    const offenders = ["app", "components"]
      .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      // Only a hard-coded plan: the funnel pages pass on a plan the visitor chose.
      .filter((file) => /["'`]\/get-started\?plan=(?!\$\{)/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    // A hard-coded plan link is a start link that picks a plan for them.
    expect(offenders).toEqual([]);
  });

  it.each([
    ["/reserve", () => import("@/app/reserve/page")],
    ["/reserved", () => import("@/app/reserved/page")],
  ])("%s, the retired waitlist link, joins them", async (_route, load) => {
    const { default: Page } = await load();
    Page();
    expect(redirectMock).toHaveBeenLastCalledWith("/sign-up");
  });
});
