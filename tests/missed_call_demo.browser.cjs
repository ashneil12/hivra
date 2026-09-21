const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const demoUrl = pathToFileURL(path.join(root, "missed-call-demo.html")).href;
const outputDir = path.join(root, "tmp", "missed-call-demo-check");
let browser;

(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => { window.__CLEARWEB_TIMING_SCALE__ = 0.05; });
  await page.goto(demoUrl, { waitUntil: "load" });
  await page.addStyleTag({
    content: "*:not(.typing-bubble):not(.typing-bubble *), *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
  });

  async function capture(name) {
    await page.waitForTimeout(40);
    const scrollPosition = await page.evaluate(() => ({
      x: scrollX,
      y: scrollY,
      canvasX: document.querySelector(".viewport").scrollLeft,
      canvasY: document.querySelector(".viewport").scrollTop,
    }));
    assert.deepEqual(scrollPosition, { x: 0, y: 0, canvasX: 0, canvasY: 0 }, `${name} must remain anchored to the recording canvas`);
    await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
  }

  async function hasClass(selector, className = "visible") {
    return page.locator(selector).evaluate((element, state) => element.classList.contains(state), className);
  }

  async function currentStep() {
    return Number(await page.locator("#demo-stage").getAttribute("data-current-step"));
  }

  async function revealStep(messageSelector, typingSelector) {
    await page.keyboard.press("ArrowRight");
    assert.equal(await hasClass(typingSelector, "play"), true, `${typingSelector} must appear before the answer`);
    assert.equal(await hasClass(messageSelector), false, `${messageSelector} must wait while typing is visible`);
    await page.waitForTimeout(125);
    assert.equal(await hasClass(typingSelector, "play"), false);
    assert.equal(await hasClass(messageSelector), true);
  }

  await capture("01-clearweb-intro");
  assert.equal(await hasClass("#intro", "hidden"), false);
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "opening frame must not show a forced focus ring");
  assert.equal(await page.locator("#advance").count(), 0);
  assert.equal(await page.locator(".progress-wrap").count(), 0);

  await page.locator("#intro").click();
  await capture("02-incoming-call");
  assert.equal(await hasClass("#demo-stage", "active"), true);
  assert.equal(await currentStep(), 0);
  assert.equal(await page.locator("#call-state").textContent(), "Ringing…");
  assert.equal(await page.locator(".booking-row.existing").count(), 3);

  await page.keyboard.press("ArrowRight");
  assert.equal(await currentStep(), 1);
  assert.equal(await page.locator("#call-state").textContent(), "Missed call");

  await page.keyboard.press("ArrowLeft");
  assert.equal(await currentStep(), 0);
  assert.equal(await page.locator("#call-state").textContent(), "Ringing…");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await currentStep(), 2);
  assert.equal(await hasClass("#typing-business", "play"), true);
  assert.equal(await hasClass("#auto-text"), false);
  await page.waitForTimeout(125);
  assert.equal(await hasClass("#auto-text"), true);
  await capture("03-instant-reply");

  await revealStep("#customer-reply", "#typing-customer-one");
  await revealStep("#qualification", "#typing-assistant-one");
  assert.match(await page.locator("#qualification").textContent(), /Do you need Dave to call as soon as he's free, or can it wait until tomorrow/);
  await capture("04-urgency-check");

  await revealStep("#booking-reply", "#typing-customer-two");
  assert.match(await page.locator("#booking-reply").textContent(), /It can wait until tomorrow/);

  await revealStep("#booking-confirmation", "#typing-assistant-two");
  assert.match(await page.locator("#booking-confirmation").textContent(), /If it becomes urgent, reply here and we'll get him to call as soon as possible/);
  await capture("05-booked-conversation");

  await page.keyboard.press("ArrowRight");
  assert.equal(await hasClass("#lead-alert"), true);
  assert.equal(await hasClass("#owner-group", "inactive"), false);
  assert.equal(await page.locator("#lead-alert .booking-status").textContent(), "Awaiting confirmation");
  await capture("06-populated-bookings");

  await page.keyboard.press("ArrowRight");
  assert.equal(await hasClass("#end-card"), true);
  await capture("07-end-card");

  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > innerWidth,
    vertical: document.documentElement.scrollHeight > innerHeight,
    x: scrollX,
    y: scrollY,
  }));
  assert.deepEqual(overflow, { horizontal: false, vertical: false, x: 0, y: 0 });

  await page.locator("#replay").click();
  assert.equal(await hasClass("#intro", "hidden"), false);
  await page.waitForTimeout(240);
  assert.equal(await hasClass("#demo-stage", "active"), true, "the intro must start itself on its timer");
  assert.equal(await currentStep(), 0);
  await page.waitForTimeout(340);
  assert.ok(await currentStep() >= 1, "the story must continue on its own without keyboard input");

  await browser.close();
  browser = undefined;
  console.log("Timed browser sequence passed at 1920x1080; screenshots saved to tmp/missed-call-demo-check.");
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
