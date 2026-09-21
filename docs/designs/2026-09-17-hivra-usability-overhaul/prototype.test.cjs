// Behavioral checks for the overhaul preview. Uses the dashboard's jsdom dependency.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireDashboard = createRequire(path.resolve(__dirname, "../../../dashboard/package.json"));
const { JSDOM } = requireDashboard("jsdom");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boot(t, { hash = "#home", stored = {}, denyStorage = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), {
    url: `http://localhost/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  if (w.HTMLDialogElement) {
    w.HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
  for (const [key, value] of Object.entries(stored)) w.localStorage.setItem(key, value);
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
    el.click();
    return el;
  };
  const type = (selector, value) => {
    const el = w.document.querySelector(selector);
    assert.ok(el, `Missing ${selector}`);
    el.value = value;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  const text = () => w.document.body.textContent;
  return { w, document: w.document, click, type, text };
}

test("returning home summarises the fleet and links into the workspace", (t) => {
  const { document, text, click } = boot(t);
  assert.match(text(), /Good evening/);
  assert.match(text(), /Continue/);
  assert.match(text(), /Needs attention/);

  click('a[href="#agents"]');
  assert.match(text(), /An agent runs on one of your computers/);
  assert.equal(document.querySelector(".page-title")?.textContent, "Agents");

  click('a[href="#workspace/agent/patch/chat"]');
  assert.equal(document.querySelector(".context-title h1")?.textContent, "Patch");
});

test("first-run home offers the two sibling launch actions", (t) => {
  const { w, text, click } = boot(t, { hash: "#home-empty" });
  assert.match(text(), /Give an agent its own computer/);
  assert.match(text(), /Launch an agent/);
  assert.match(text(), /Launch a computer/);

  click('[data-action="start-launch"][data-type="agent"]');
  assert.equal(w.location.hash, "#launch");
  assert.match(text(), /Configure/);
  assert.match(text(), /Runtime/);
});

test("switcher opens with ⌘K affordance, filters, and closes on Escape", (t) => {
  const { w, document, click, type } = boot(t);
  click('[data-action="open-switcher"]');
  assert.ok(document.querySelector("#switcher"), "switcher dialog exists");

  type("#switcher-input", "quill");
  assert.match(document.querySelector(".switcher-results").textContent, /Quill/);
  assert.doesNotMatch(document.querySelector(".switcher-results").textContent, /Patch/);

  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelector("#switcher"), null);
});

test("workspace switches surfaces and demonstrates detach-without-stop", (t) => {
  const { document, text, click } = boot(t, { hash: "#workspace/agent/patch/chat" });
  assert.equal(document.querySelector(".context-title h1")?.textContent, "Patch");
  assert.ok(document.querySelector(".chat"), "chat pane is the default");

  click('a[href="#workspace/agent/patch/terminal"]');
  assert.ok(document.querySelector(".term-body"), "terminal pane renders");
  assert.match(text(), /45 passed/);

  click('[data-action="term-detach"]');
  assert.match(text(), /Session still running/);
  assert.match(text(), /Detached/);
  assert.equal(document.querySelector(".term-body"), null);

  click('[data-action="term-reattach"]');
  assert.ok(document.querySelector(".term-body"), "terminal pane returns after reattach");
});

test("launch journey simulates preparation and reaches a ready hand-off", async (t) => {
  const { document, text, click } = boot(t, { hash: "#launch" });
  click('[data-action="launch-choose"][data-type="agent"]');
  assert.match(text(), /Runtime/);

  click('[data-action="launch-pick"][data-value="Claude Code"]');
  assert.equal(
    document.querySelector('[data-action="launch-pick"][data-value="Claude Code"]').getAttribute("aria-pressed"),
    "true",
  );

  click('[data-action="launch-next"]');
  assert.match(text(), /Claude Code/);
  assert.match(text(), /Review/);

  click('[data-action="launch-submit"]');
  assert.match(text(), /Preparing your agent/);

  await sleep(1400);
  assert.match(text(), /is ready/);
  assert.ok(document.querySelector('a[href^="#workspace/agent/"]'), "ready panel links to the workspace");
});

test("theme toggle flips and persists the theme", (t) => {
  const { w, click } = boot(t);
  assert.equal(w.document.documentElement.dataset.theme, "dark");
  click('[data-action="toggle-theme"]');
  assert.equal(w.document.documentElement.dataset.theme, "light");
  assert.equal(w.localStorage.getItem("preview-theme"), "light");
});

test("denied storage still boots and collapses the sidebar", (t) => {
  const { document, click } = boot(t, { denyStorage: true, stored: { "preview-sidebar": "expanded" } });
  click('[data-action="toggle-sidebar"]');
  assert.equal(document.querySelector("#app").dataset.sidebar, "collapsed");
});

test("manage drawer opens for an agent and closes from its scrim", (t) => {
  const { document, text, click } = boot(t, { hash: "#workspace/agent/patch/chat" });
  click('[data-action="open-manage"]');
  assert.match(text(), /Manage Patch/);
  assert.match(text(), /Danger zone/);
  click('[data-action="close-manage"]');
  assert.equal(document.querySelector(".drawer"), null);
});

test("computers list filters and links to the desktop workspace", (t) => {
  const { document, text, click } = boot(t, { hash: "#computers" });
  assert.match(text(), /Omarchy/);
  click('a[href="#workspace/computer/studio/desktop"]');
  assert.equal(document.querySelector(".context-title h1")?.textContent, "studio");
  assert.match(text(), /Desktop streams here/);
});

test("chat shows tool and approval cards, and approvals resolve in place", (t) => {
  const { document, text, click } = boot(t, { hash: "#workspace/agent/patch/chat" });

  const tool = document.querySelector(".tool-card");
  assert.ok(tool, "tool card renders");
  assert.equal(tool.getAttribute("data-open"), "false");
  click('[data-action="chat-tool"]');
  assert.match(document.querySelector(".tool-body").textContent, /45 passed/);

  const approval = document.querySelector('.approval-card[data-state="pending"]');
  assert.ok(approval, "approval card is pending");
  click('[data-action="chat-approve"]');
  assert.ok(document.querySelector('.approval-card[data-state="approved"]'), "approval resolves");
  assert.match(text(), /Approved — the command ran/);
});

test("chat streams a reply and offers copy", async (t) => {
  const { document, click, type, text } = boot(t, { hash: "#workspace/agent/patch/chat" });
  type('[data-input="chat-draft"]', "Check the retry policy again");
  click('[data-action="chat-send"]');
  assert.ok(document.querySelector(".dots"), "streaming indicator appears");
  assert.match(text(), /Check the retry policy again/);

  await sleep(1200);
  assert.equal(document.querySelector(".dots"), null);
  assert.match(text(), /preview reply from Patch/);

  click('[data-action="chat-copy"]');
  assert.match(document.getElementById("toast").textContent, /Copied/);
});

test("sessions can start a fresh chat and restore the transcript", (t) => {
  const { document, click, type, text, w } = boot(t, { hash: "#workspace/agent/patch/chat" });
  click('[data-action="toggle-menu"][data-menu="sessions"]');
  click('[data-action="session-new"]');
  assert.match(text(), /Start a conversation with Patch/);
  assert.ok(document.querySelector(".suggestion-row"), "suggestions are offered");

  click(".suggestion");
  assert.equal(document.querySelector('[data-input="chat-draft"]').value, "Summarise what changed today");

  click('[data-action="toggle-menu"][data-menu="sessions"]');
  click('[data-action="session-pick"][data-session="Test triage"]');
  assert.equal(w.document.querySelector(".chat-empty"), null);
  assert.match(text(), /billing adapter refactor/i);
});

test("computer resize is a real flow with a pending state", (t) => {
  const { document, text, click } = boot(t, { hash: "#workspace/computer/devbox/desktop" });
  click('[data-action="open-manage"]');
  click('[data-action="manage-resize-open"]');
  assert.ok(document.querySelector(".resize-editor"), "resize editor opens");

  click('[data-action="manage-step"][data-key="cpu"][data-delta="1"]');
  assert.match(document.querySelector(".stepper-value").textContent, /3/);

  click('[data-action="manage-preset"][data-cpu="4"][data-ram="8"]');
  assert.equal(
    document.querySelector('[data-action="manage-preset"][data-cpu="4"]').getAttribute("aria-pressed"),
    "true",
  );

  click('[data-action="manage-apply"]');
  assert.match(text(), /Pending resize/);
  click('[data-action="close-manage"]');
  assert.match(document.body.textContent, /Resize pending · applies at restart/);
});

test("pending resize can be cancelled", (t) => {
  const { document, click } = boot(t, { hash: "#workspace/computer/devbox/desktop" });
  click('[data-action="open-manage"]');
  click('[data-action="manage-resize-open"]');
  click('[data-action="manage-apply"]');
  click('[data-action="manage-cancel"]');
  assert.equal(document.querySelector(".pending-banner"), null);
});

test("restart shows a starting state and returns to running", async (t) => {
  const { document, click, text } = boot(t, { hash: "#workspace/computer/devbox/desktop" });
  click('[data-action="open-manage"]');
  click('[data-action="manage-restart"]');
  assert.match(text(), /Starting/);

  await sleep(1600);
  assert.match(document.querySelector(".drawer").textContent, /Running/);
});

test("rename updates the resource everywhere", (t) => {
  const { document, click, type } = boot(t, { hash: "#workspace/computer/devbox/desktop" });
  click('[data-action="open-manage"]');
  type('[data-input="manage-rename"]', "workbench");
  click('[data-action="manage-rename-save"]');
  assert.equal(document.querySelector(".drawer-head h2").textContent, "Manage workbench");
  click('[data-action="close-manage"]');
  assert.equal(document.querySelector(".context-title h1").textContent, "workbench");
});

test("destroy requires the typed name before the button enables", (t) => {
  const { document, click, type } = boot(t, { hash: "#workspace/computer/devbox/desktop" });
  click('[data-action="open-manage"]');
  const destroy = document.querySelector('[data-action="manage-destroy"]');
  assert.ok(destroy.hasAttribute("disabled"), "destroy starts disabled");

  type('[data-input="manage-destroy"]', "wrong-name");
  assert.ok(destroy.hasAttribute("disabled"), "still disabled for a mismatch");

  type('[data-input="manage-destroy"]', "devbox");
  assert.ok(!destroy.hasAttribute("disabled"), "enabled for the exact name");
  destroy.click();
  assert.equal(document.querySelector(".drawer"), null, "drawer closes after confirmation");
});

test("rail groups collapse and show their counts", (t) => {
  const { document, click } = boot(t, { hash: "#workspace/agent/patch/chat" });
  const toggle = '[data-action="toggle-rail-group"][data-group="computer"]';
  assert.ok(document.querySelector(toggle), "group toggle exists");
  assert.match(document.querySelector(".rail").textContent, /studio/);
  click(toggle);
  assert.doesNotMatch(document.querySelector(".rail").textContent, /studio/);
  assert.equal(document.querySelector(toggle).getAttribute("aria-expanded"), "false");
});
