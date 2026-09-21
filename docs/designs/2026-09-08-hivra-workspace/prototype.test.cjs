// Behavioral checks use the dashboard's existing jsdom dependency.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const requireDashboard = createRequire(
  path.resolve(__dirname, "../../../dashboard/package.json"),
);
const { JSDOM } = requireDashboard("jsdom");

function boot(t, { stored = {}, denyStorage = false, hash = "#home" } = {}) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, "index.html"), "utf8"),
    {
      url: `http://localhost/${hash}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  for (const [key, value] of Object.entries(stored))
    w.localStorage.setItem(key, value);
  if (denyStorage) {
    w.Storage.prototype.setItem = () => {
      throw new Error("Storage denied for test");
    };
  }
  w.eval(fs.readFileSync(path.join(__dirname, "assets/icons.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"));
  const click = (selector) => {
    const el = w.document.querySelector(selector);
    assert.ok(el, `Missing ${selector}`);
    el.focus();
    el.click();
  };
  const input = (selector, value) => {
    const el = w.document.querySelector(selector);
    assert.ok(el, `Missing ${selector}`);
    el.value = value;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  return { w, document: w.document, click, input };
}

test("ambient network is static for reduced motion and pauses when hidden", (t) => {
  const { w } = boot(t);
  const reduced = {
    matches: true,
    addEventListener: (_, listener) => {
      reduced.change = listener;
    },
  };
  w.matchMedia = () => reduced;
  let nextFrame = 0;
  const scheduled = new Set();
  w.requestAnimationFrame = () => {
    scheduled.add(++nextFrame);
    return nextFrame;
  };
  w.cancelAnimationFrame = (id) => scheduled.delete(id);
  const context = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  };
  w.HTMLCanvasElement.prototype.getContext = () => context;
  w.eval(fs.readFileSync(path.join(__dirname, "atmosphere.js"), "utf8"));
  assert.equal(scheduled.size, 0, "reduced motion must not schedule animation");
  reduced.matches = false;
  reduced.change();
  assert.equal(
    scheduled.size,
    1,
    "normal motion should have one animation loop",
  );
  Object.defineProperty(w.document, "hidden", {
    configurable: true,
    value: true,
  });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  assert.equal(scheduled.size, 0, "background tabs should stop animating");
  Object.defineProperty(w.document, "hidden", {
    configurable: true,
    value: false,
  });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  assert.equal(scheduled.size, 1, "visible tabs resume one loop");
  reduced.matches = true;
  reduced.change();
  assert.equal(scheduled.size, 0, "changing to reduced motion stops the loop");
});

test("agent drafts remain with their recipient across switching and reload", (t) => {
  const a = boot(t);
  a.click('[data-agent="atlas"]');
  a.input("#composer", "Only for Atlas");
  a.click('[data-action="save-agent-draft"]');
  a.click('[data-agent="patch"]');
  assert.equal(a.document.querySelector("#composer"), null);
  assert.equal(
    a.document.querySelector("main").textContent.includes("Only for Atlas"),
    false,
  );
  a.click('[data-agent="atlas"]');
  assert.equal(a.document.querySelector("#composer").value, "Only for Atlas");
  const b = boot(t, {
    hash: "#agent/atlas",
    stored: {
      "hivra-design-agent-drafts": a.w.localStorage.getItem(
        "hivra-design-agent-drafts",
      ),
    },
  });
  assert.equal(b.document.querySelector("#composer").value, "Only for Atlas");
});

test("launch configuration restores after saving and reopening in a fresh page", (t) => {
  const a = boot(t);
  a.click('[data-action="launch"]');
  a.click('[data-launch-type="computer"]');
  a.click('[data-action="launch-next"]');
  assert.equal(
    a.document.querySelector("#launch-name").value,
    "Ubuntu computer",
  );
  a.input("#launch-name", "Design review computer");
  a.click('[data-action="launch-location"]');
  a.input('[data-launch-field="location"]', "Existing host (example)");
  a.click('[data-action="launch-next"]');
  a.click('[data-action="launch-next"]');
  assert.match(
    a.document.querySelector("dialog").textContent,
    /Launch draft saved/,
  );
  const b = boot(t, {
    stored: {
      "hivra-design-launch-draft": a.w.localStorage.getItem(
        "hivra-design-launch-draft",
      ),
    },
  });
  b.click('[data-action="launch"]');
  assert.match(
    b.document.querySelector("dialog").textContent,
    /Design review computer/,
  );
  assert.match(
    b.document.querySelector("dialog").textContent,
    /Existing host \(example\)/,
  );
  b.click('[data-action="launch-back"]');
  assert.equal(
    b.document.querySelector("#launch-name").value,
    "Design review computer",
  );
});

test("unavailable storage never claims a draft was persisted", (t) => {
  const a = boot(t, { denyStorage: true });
  a.click('[data-agent="atlas"]');
  a.input("#composer", "Session only");
  a.click('[data-action="save-agent-draft"]');
  assert.match(a.document.querySelector("#toast").textContent, /this tab only/);
  a.click('[data-action="launch"]');
  a.click('[data-action="launch-next"]');
  a.click('[data-action="launch-next"]');
  a.click('[data-action="launch-next"]');
  assert.equal(
    a.document
      .querySelector("dialog")
      .textContent.includes("Launch draft saved"),
    false,
  );
  assert.match(a.document.querySelector("#toast").textContent, /not saved/);
});

test("resource tabs support arrows, roving focus and named panels", (t) => {
  const a = boot(t, { hash: "#agent/atlas" });
  a.click("#resource-tab-conversation");
  a.document.activeElement.dispatchEvent(
    new a.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.equal(a.document.activeElement.id, "resource-tab-native");
  assert.equal(
    a.document.querySelectorAll('[role="tab"][tabindex="0"]').length,
    1,
  );
  assert.equal(
    a.document
      .querySelector('[role="tabpanel"]')
      .getAttribute("aria-labelledby"),
    "resource-tab-native",
  );
  a.document.activeElement.dispatchEvent(
    new a.w.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  assert.equal(a.document.activeElement.id, "resource-tab-files");
});

test("launch headings receive focus and closing returns to the correct trigger", (t) => {
  const a = boot(t);
  a.click('[data-action="switcher"]');
  a.click('[data-action="close-modal"]');
  a.click('[data-action="launch"]');
  assert.ok(a.document.activeElement.classList.contains("launch-question"));
  a.click('[data-action="launch-next"]');
  assert.ok(a.document.activeElement.classList.contains("launch-question"));
  a.click('[data-action="close-modal"]');
  assert.equal(a.document.activeElement.dataset.action, "launch");
});

test("skip link focuses the active workspace without changing resource route", (t) => {
  const a = boot(t, { hash: "#agent/atlas" });
  a.click(".skip-link");
  assert.equal(a.document.activeElement.id, "main");
  assert.equal(a.w.location.hash, "#agent/atlas");
});
