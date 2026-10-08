/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_LAUNCH_HREF, computerLaunchHref } from "../content";

// The litepaper is a static page built by docs/litepaper/build.py. Its launch
// buttons must open Launch exactly the way the homepage's do.
const litepaper = readFileSync(path.resolve(__dirname, "../../../../../../docs/litepaper/index.html"), "utf8");

function launchLinks(className: string): string[] {
  return [...litepaper.matchAll(new RegExp(`<a class="${className}" href="([^"]+)"`, "g"))].map(match => match[1].replace(/&amp;/g, "&"));
}

it("the litepaper launches an agent or a computer with the homepage's links", () => {
  expect(launchLinks("dock-launch")).toEqual([AGENT_LAUNCH_HREF]);
  expect(launchLinks("finale-launch")).toEqual([AGENT_LAUNCH_HREF]);
  expect(launchLinks("finale-computer")).toEqual([computerLaunchHref("ubuntu-desktop")]);
});
