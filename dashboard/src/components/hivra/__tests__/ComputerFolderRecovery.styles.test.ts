/** @jest-environment node */

import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

// JSDOM does not model CSS cascade specificity faithfully. Exercise the real
// scoped stylesheet against the global reset in Chromium, without a network.
it("keeps recovery controls visible against the global reset in both themes", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const css = readFileSync(path.join(__dirname, "../ComputerFolderRecovery.module.css"), "utf8");
    for (const dark of [true, false]) {
      await page.setContent(`<style>:root { --text-primary: ${dark ? "#fdfcf9" : "#1a1a1a"}; --bg-primary: ${dark ? "#0d0d0d" : "#fdfcf9"}; --bg-elevated: ${dark ? "#1a1a1a" : "#faf9f6"}; --etched-border: #777; } ${css}
        * { margin: 0; padding: 0; } button { border: none; background: none; }</style>
        <div class="page"><button class="button" disabled>Download encrypted folder</button><input class="input" type="password"></div>`);
      const observed = await page.evaluate(() => {
        const button = getComputedStyle(document.querySelector("button")!);
        const input = getComputedStyle(document.querySelector("input")!);
        return { padding: button.padding, border: button.borderTopWidth, background: button.backgroundColor,
          color: button.color, minHeight: button.minHeight, inputPadding: input.paddingLeft };
      });
      expect(observed).toEqual({ padding: "11px 16px", border: "1px", minHeight: "44px", inputPadding: "12px",
        background: dark ? "rgb(253, 252, 249)" : "rgb(26, 26, 26)",
        color: dark ? "rgb(13, 13, 13)" : "rgb(253, 252, 249)" });
    }
  } finally { await browser.close(); }
}, 20_000);
