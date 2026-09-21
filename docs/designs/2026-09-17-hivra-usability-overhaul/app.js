/* Hivra usability overhaul — standalone click-through preview.
   Fictional example data. No network calls, no provisioning, no real actions.
   Routes: #home #home-empty #agents #computers #launch #workspace/<kind>/<id>/<surface> #activity */
(() => {
  "use strict";

  const icons = window.HIVRA_ICONS || {};
  const icon = (name, extra = "") => {
    const svg = icons[name] || icons.Circle || "";
    return extra ? svg.replace("<svg ", `<svg class="${extra}" `) : svg;
  };
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  const $ = (selector, root = document) => root.querySelector(selector);

  /* ------------------------------------------------------------------ data */

  const agents = [
    {
      id: "patch",
      name: "Patch",
      runtime: "Codex",
      computer: "devbox",
      status: "running",
      activity: "Updating the billing adapter",
      lastActive: "2m ago",
    },
    {
      id: "quill",
      name: "Quill",
      runtime: "Claude Code",
      computer: "devbox",
      status: "idle",
      activity: "Code review — 3 files changed",
      lastActive: "1h ago",
    },
    {
      id: "kernel",
      name: "Kernel",
      runtime: "Hermes",
      computer: "studio",
      status: "stopped",
      activity: "Stopped while running a task",
      lastActive: "Yesterday",
    },
  ];

  const computers = [
    { id: "devbox", name: "devbox", os: "Ubuntu Desktop", size: "2 vCPU · 4 GB", cpu: 2, ram: 4, diskUsed: 18, diskTotal: 64, status: "running", lastActive: "Now" },
    { id: "studio", name: "studio", os: "Omarchy", size: "4 vCPU · 8 GB", cpu: 4, ram: 8, diskUsed: 41, diskTotal: 128, status: "running", lastActive: "1h ago" },
    { id: "win-lab", name: "win-lab", os: "Windows 11", size: "2 vCPU · 8 GB", cpu: 2, ram: 8, diskUsed: 52, diskTotal: 96, status: "stopped", lastActive: "Yesterday" },
  ];

  const activityLog = [
    { icon: "Terminal", text: "Patch ran a command on devbox", time: "2m ago" },
    { icon: "Monitor", text: "Desktop session started on studio", time: "1h ago" },
    { icon: "CircleAlert", text: "Kernel stopped after an interrupted task", time: "Yesterday" },
    { icon: "ShieldCheck", text: "Quill reviewed your launch settings", time: "2d ago" },
  ];

  const statusWord = { running: "Running", idle: "Idle", stopped: "Stopped", error: "Needs attention", starting: "Starting" };

  /* ----------------------------------------------------------------- state */

  const readStore = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };
  const writeStore = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Storage denied: the preview continues without persistence. */
    }
  };

  const state = {
    sidebar: readStore("preview-sidebar", "expanded"),
    mobileNav: false,
    menu: null,
    railOpen: false,
    railCollapsed: { agent: false, computer: false },
    drawer: null, // "<kind>:<id>" when open
    switcher: { open: false, query: "", cursor: 0 },
    search: { agents: "", computers: "", rail: "" },
    filter: { agents: "all", computers: "all" },
    term: { sessions: ["main"], active: "main", detached: false },
    chat: { draft: "", streaming: false },
    threads: {}, // per-agent message arrays
    session: { name: "Billing refactor", list: ["Billing refactor", "Test triage", "Release prep"] },
    manage: { resize: null, destroyInput: "", renameDraft: "", telegram: true },
    pendingResizes: {}, // computer id -> { cpu, ram }
    launch: {
      step: 1,
      type: "agent",
      runtime: "Codex",
      os: "Ubuntu Desktop",
      placement: "new",
      name: "Scout",
      size: "2 vCPU · 4 GB",
      phase: "form",
      progress: 0,
      createdAgentId: null,
    },
  };

  const themePref = readStore("preview-theme", "dark");
  document.documentElement.dataset.theme = themePref === "light" ? "light" : "dark";

  const navigate = (hash, { focus = true } = {}) => {
    if (location.hash === hash) render();
    else history.pushState(null, "", hash);
    render();
    if (focus) {
      const main = $("#main");
      main?.focus?.({ preventScroll: true });
    }
  };

  const toast = (message) => {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => el.classList.remove("show"), 2400);
  };

  /* ------------------------------------------------------------ helpers */

  const route = () => {
    const raw = location.hash.replace(/^#/, "") || "home";
    const [view, ...rest] = raw.split("/");
    return { view, rest };
  };

  const findAgent = (id) => agents.find((agent) => agent.id === id);
  const findComputer = (id) => computers.find((computer) => computer.id === id);

  const statusEl = (status) =>
    `<span class="status"><span class="status-dot" data-state="${esc(status)}"></span>${esc(statusWord[status] || status)}</span>`;

  const surfaceTabs = (kind) =>
    kind === "agent"
      ? [
          { id: "chat", label: "Chat", icon: "MessageSquare" },
          { id: "terminal", label: "Terminal", icon: "Terminal" },
          { id: "desktop", label: "Desktop", icon: "Monitor" },
          { id: "files", label: "Files", icon: "Folder" },
        ]
      : [
          { id: "desktop", label: "Desktop", icon: "Monitor" },
          { id: "terminal", label: "Terminal", icon: "Terminal" },
          { id: "files", label: "Files", icon: "Folder" },
        ];
  const moreSurfaces = (kind) =>
    kind === "agent"
      ? [
          { id: "browser", label: "Browser" },
          { id: "git", label: "Git" },
          { id: "skills", label: "Skills" },
          { id: "tasks", label: "Tasks" },
        ]
      : [
          { id: "browser", label: "Browser" },
          { id: "git", label: "Git" },
        ];

  /* ------------------------------------------------------------- sidebar */

  const sidebarNav = [
    { id: "home", label: "Home", href: "#home", icon: "House" },
    { id: "agents", label: "Agents", href: "#agents", icon: "Bot" },
    { id: "computers", label: "Computers", href: "#computers", icon: "Monitor" },
    { id: "launch", label: "Launch", href: "#launch", icon: "Plus", launch: true },
    { id: "activity", label: "Activity", href: "#activity", icon: "Activity" },
  ];
  const sidebarSecondary = [
    { id: "infrastructure", label: "Infrastructure", href: "#infrastructure", icon: "Server" },
    { id: "settings", label: "Settings", href: "#settings", icon: "Settings" },
  ];
  const sidebarFoot = [
    { id: "applications", label: "Applications", href: "#applications", icon: "Download" },
    { id: "help", label: "Help", href: "#help", icon: "CircleHelp" },
  ];

  const navLink = (item) => {
    const { view } = route();
    const active = view === item.id || (item.id === "home" && view === "home-empty");
    return `<a class="side-link${item.launch ? " nav-launch" : ""}" href="${item.href}" data-nav
      ${active ? 'aria-current="true"' : ""}>${icon(item.icon)}<span class="side-label">${item.label}</span></a>`;
  };

  const renderSidebar = () => `
    <aside class="sidebar" id="sidebar">
      <div class="side-head">
        <a class="brand" href="#home" data-nav aria-label="Hivra home">
          <span class="brand-mark">H</span><span class="brand-name">Hivra</span>
        </a>
        <button class="icon-btn" type="button" data-action="toggle-sidebar" aria-label="Collapse sidebar">${icon("PanelRight")}</button>
      </div>
      <button class="palette" type="button" data-action="open-switcher">
        ${icon("Search")}<span class="side-label">Search fleet…</span><kbd>⌘K</kbd>
      </button>
      <nav class="nav" aria-label="Primary">
        ${sidebarNav.map(navLink).join("")}
      </nav>
      <div class="side-gap"></div>
      <nav class="nav" aria-label="Secondary">
        ${sidebarSecondary.map(navLink).join("")}
      </nav>
      <div class="side-foot">
        ${sidebarFoot.map(navLink).join("")}
        <div class="account">
          <span class="account-avatar">A</span>
          <span class="account-copy"><strong>Ash</strong><small>Canary · preview</small></span>
        </div>
      </div>
    </aside>`;

  const renderMobileBar = () => `
    <div class="mobile-bar">
      <button class="icon-btn" type="button" data-action="toggle-mobile-nav" aria-label="Open navigation">${icon("Menu")}</button>
      <span class="brand-mark">H</span>
      <span class="grow"></span>
      <button class="icon-btn" type="button" data-action="open-switcher" aria-label="Search fleet">${icon("Search")}</button>
    </div>`;

  const renderBottomNav = () =>
    `<nav class="bottom-nav" aria-label="Mobile">
      ${sidebarNav
        .filter((item) => item.id !== "activity")
        .map((item) => {
          const { view } = route();
          const active = view === item.id || (item.id === "home" && view === "home-empty");
          return `<a href="${item.href}" data-nav ${active ? 'aria-current="true"' : ""}>${icon(item.icon)}<span>${item.label}</span></a>`;
        })
        .join("")}
    </nav>`;

  /* --------------------------------------------------------------- views */

  const viewHome = (firstRun) => {
    if (firstRun) {
      return `
      <div class="first-run">
        <p class="eyebrow">First arrival</p>
        <h1 class="serif-title">Give an agent its own computer.</h1>
        <p>Hivra runs your agents on computers that stay online when your laptop closes. Start with an agent, or just a computer — no agent required.</p>
        <div class="first-run-grid">
          <button class="choice-card" type="button" data-action="start-launch" data-type="agent">
            ${icon("Bot")}<strong>Launch an agent</strong>
            <p>Pick a runtime, get a computer, and open its workspace. Ready in a few minutes.</p>
          </button>
          <button class="choice-card" type="button" data-action="start-launch" data-type="computer">
            ${icon("Monitor")}<strong>Launch a computer</strong>
            <p>An Ubuntu, Omarchy or Windows desktop with terminal, files and recovery built in.</p>
          </button>
        </div>
      </div>`;
    }

    const running = agents.filter((agent) => agent.status === "running");
    const pinned = agents.filter((agent) => agent.id === "patch");
    const continueAgents = (pinned.length ? pinned : running).slice(0, 1);
    const continueComputers = computers.filter((computer) => computer.status === "running").slice(0, 1);

    const continueCards = [...continueAgents.map((agent) => ({ kind: "agent", item: agent })), ...continueComputers.map((computer) => ({ kind: "computer", item: computer }))]
      .map(({ kind, item }) => {
        const isAgent = kind === "agent";
        const meta = isAgent ? `${item.runtime} · on ${esc(item.computer)}` : `${item.os} · ${item.size}`;
        const note = isAgent ? esc(item.activity) : "Desktop, terminal and files ready";
        const href = isAgent ? `#workspace/agent/${item.id}/chat` : `#workspace/computer/${item.id}/desktop`;
        return `
        <article class="card">
          <div class="card-head">${icon(isAgent ? "Bot" : "Laptop")}<span class="card-title">${esc(item.name)}</span>${statusEl(item.status)}</div>
          <div class="card-body"><p class="card-meta">${meta}<br />${note}</p></div>
          <div class="card-actions">
            <a class="btn btn-primary btn-small" href="${href}" data-nav>Open</a>
            <button class="btn btn-ghost btn-small" type="button" data-action="open-manage" data-kind="${kind}" data-id="${item.id}">Manage</button>
          </div>
        </article>`;
      })
      .join("");

    const attention = findAgent("kernel");

    return `
      <div class="home-greeting">
        <h1 class="serif-title">Good evening.</h1>
        <p>Your fleet is quiet. Patch is mid-task on devbox; everything else is waiting for you.</p>
      </div>

      <section class="section">
        <div class="section-head"><h2>Continue</h2><a href="#agents" data-nav>All agents</a></div>
        <div class="cards">${continueCards}</div>
      </section>

      ${
        attention
          ? `<section class="section">
        <div class="section-head"><h2>Needs attention</h2></div>
        <div class="cards">
          <article class="card attention-card">
            <div class="card-head">${icon("CircleAlert")}<span class="card-title">${esc(attention.name)} stopped</span></div>
            <div class="card-body"><p class="card-meta">${esc(attention.activity)} — ${esc(attention.lastActive)}. Its computer (${esc(attention.computer)}) is still running.</p></div>
            <div class="card-actions">
              <a class="btn btn-ghost btn-small" href="#workspace/agent/${attention.id}/chat" data-nav>Open</a>
              <button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Restart prepares the runtime and reopens the session.">Restart</button>
            </div>
          </article>
        </div>
      </section>`
          : ""
      }

      <section class="section">
        <div class="section-head"><h2>Recent</h2><a href="#activity" data-nav>Activity</a></div>
        <div class="recent-list">
          ${[
            { icon: "Bot", name: "Patch · Codex", note: "Updated the billing adapter", time: "2m ago", href: "#workspace/agent/patch/chat" },
            { icon: "Monitor", name: "studio · Omarchy", note: "Desktop session", time: "1h ago", href: "#workspace/computer/studio/desktop" },
            { icon: "Bot", name: "Quill · Claude Code", note: "Reviewed 3 files", time: "Yesterday", href: "#workspace/agent/quill/chat" },
          ]
            .map(
              (row) => `
            <a class="recent-row" href="${row.href}" data-nav>
              ${icon(row.icon)}
              <span class="recent-copy"><strong>${row.name}</strong><small>${row.note}</small></span>
              <span class="recent-time">${row.time}</span>
            </a>`,
            )
            .join("")}
        </div>
      </section>`;
  };

  const filtered = (list, query, filterKey) => {
    const q = query.trim().toLowerCase();
    return list.filter((item) => {
      const haystack = `${item.name} ${item.runtime || item.os || ""} ${item.computer || ""}`.toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (filterKey === "all") return true;
      if (filterKey === "attention") return item.status === "error" || item.status === "stopped";
      return item.status === filterKey;
    });
  };

  const kebabMenu = (kind, id) => {
    const key = `${kind}:${id}`;
    if (state.menu !== key) {
      return `<span class="menu"><button class="icon-btn" type="button" data-action="toggle-menu" data-menu="${key}" aria-label="More actions" aria-expanded="false">${icon("MoreHorizontal")}</button></span>`;
    }
    const items =
      kind === "agent"
        ? [
            { label: "Open workspace", href: `#workspace/agent/${id}/chat` },
            { label: "Open terminal", href: `#workspace/agent/${id}/terminal` },
            { label: "Manage", action: "open-manage", kind: "agent", id },
            { label: "Stop", action: "mock", note: "Stop ends the session; the computer keeps running." },
          ]
        : [
            { label: "Open desktop", href: `#workspace/computer/${id}/desktop` },
            { label: "Manage", action: "open-manage", kind: "computer", id },
            { label: "Restart", action: "mock", note: "Restart interrupts the session briefly." },
            { label: "Stop", action: "mock", note: "Stop powers the computer off. Files stay on disk." },
          ];
    return `
      <span class="menu">
        <button class="icon-btn" type="button" data-action="toggle-menu" data-menu="${key}" aria-label="More actions" aria-expanded="true">${icon("MoreHorizontal")}</button>
        <span class="menu-pop">
          ${items
            .map((item) =>
              item.href
                ? `<a href="${item.href}" data-nav>${item.label}</a>`
                : `<button type="button" data-action="${item.action}"${item.kind ? ` data-kind="${item.kind}" data-id="${item.id}"` : ""}${item.note ? ` data-note="${item.note}"` : ""}>${item.label}</button>`,
            )
            .join("")}
        </span>
      </span>`;
  };

  const filterSegment = (scope, options) => `
    <span class="seg" role="group" aria-label="${scope} filter">
      ${options
        .map(
          ([value, label]) =>
            `<button type="button" data-action="set-filter" data-scope="${scope}" data-value="${value}" aria-pressed="${state.filter[scope] === value}">${label}</button>`,
        )
        .join("")}
    </span>`;

  const agentRows = () => {
    const list = filtered(agents, state.search.agents, state.filter.agents);
    return list.length
      ? list
          .map(
            (agent) => `
          <div class="row">
            ${icon("Bot")}
            <span class="row-main">
              <span class="row-name"><span class="status-dot" data-state="${esc(agent.status)}"></span>${esc(agent.name)}</span>
              <span class="row-meta">${esc(agent.runtime)} · on <a href="#workspace/computer/${agent.computer}/desktop" data-nav>${esc(agent.computer)}</a></span>
              <span class="row-meta">${esc(agent.activity)}</span>
            </span>
            ${statusEl(agent.status)}
            <span class="row-actions">
              <a class="btn btn-primary btn-small" href="#workspace/agent/${agent.id}/chat" data-nav>Open</a>
              ${kebabMenu("agent", agent.id)}
            </span>
          </div>`,
          )
          .join("")
      : `<div class="rows-empty">No agents match this filter.</div>`;
  };

  const computerRows = () => {
    const list = filtered(computers, state.search.computers, state.filter.computers);
    return list.length
      ? list
          .map((computer) => {
            const owner = agents.find((agent) => agent.computer === computer.id && agent.status !== "stopped");
            return `
          <div class="row">
            ${icon("Laptop")}
            <span class="row-main">
              <span class="row-name"><span class="status-dot" data-state="${esc(computer.status)}"></span>${esc(computer.name)}</span>
              <span class="row-meta">${esc(computer.os)} · ${esc(computer.size)}</span>
              <span class="row-meta">${owner ? `Agent: <a href="#workspace/agent/${owner.id}/chat" data-nav>${esc(owner.name)}</a>` : "No agent"}</span>
            </span>
            ${statusEl(computer.status)}
            <span class="row-actions">
              <a class="btn btn-primary btn-small" href="#workspace/computer/${computer.id}/desktop" data-nav>Open</a>
              ${kebabMenu("computer", computer.id)}
            </span>
          </div>`;
          })
          .join("")
      : `<div class="rows-empty">No computers match this filter.</div>`;
  };

  const viewAgents = () => {
    return `
      <div class="page-head">
        <div class="grow">
          <p class="eyebrow">Fleet</p>
          <h1 class="page-title">Agents</h1>
          <p class="page-sub">An agent runs on one of your computers. Open it to talk, or open its computer for terminal and files.</p>
        </div>
        <button class="btn btn-primary" type="button" data-action="start-launch" data-type="agent">${icon("Plus")}New agent</button>
      </div>
      <div class="toolbar">
        <label class="search">${icon("Search")}<input type="search" placeholder="Filter agents" value="${esc(state.search.agents)}" data-input="agents" aria-label="Filter agents" /></label>
        ${filterSegment("agents", [["all", "All"], ["running", "Running"], ["idle", "Idle"], ["stopped", "Stopped"]])}
      </div>
      <div class="rows" id="agents-rows">${agentRows()}</div>
      <details class="explore">
        <summary>${icon("ChevronRight")}Explore runtimes — add Codex, Claude Code or Hermes to a computer</summary>
        <div class="explore-body">
          <div class="explore-options">
            ${[
              ["Codex", "Terminal-first coding agent"],
              ["Claude Code", "Long-running refactors and review"],
              ["Hermes", "General operator with desktop and files"],
            ]
              .map(([name, note]) => `<div class="explore-option"><strong>${name}</strong><small>${note}</small></div>`)
              .join("")}
          </div>
          <p class="muted-note">Catalogue stays out of the daily path — it only appears when you add a runtime.</p>
        </div>
      </details>`;
  };

  const viewComputers = () => {
    return `
      <div class="page-head">
        <div class="grow">
          <p class="eyebrow">Fleet</p>
          <h1 class="page-title">Computers</h1>
          <p class="page-sub">Every computer works on its own — with or without an agent. Open one for desktop, terminal and files.</p>
        </div>
        <button class="btn btn-primary" type="button" data-action="start-launch" data-type="computer">${icon("Plus")}New computer</button>
      </div>
      <div class="toolbar">
        <label class="search">${icon("Search")}<input type="search" placeholder="Filter computers" value="${esc(state.search.computers)}" data-input="computers" aria-label="Filter computers" /></label>
        ${filterSegment("computers", [["all", "All"], ["running", "Running"], ["stopped", "Stopped"]])}
      </div>
      <div class="rows" id="computers-rows">${computerRows()}</div>
      <details class="explore">
        <summary>${icon("ChevronRight")}Explore operating systems — Ubuntu, Omarchy and Windows profiles</summary>
        <div class="explore-body">
          <div class="explore-options">
            ${[
              ["Ubuntu Desktop", "Familiar Linux desktop"],
              ["Omarchy", "Tiling desktop for power users"],
              ["Windows", "Bring your own license"],
            ]
              .map(([name, note]) => `<div class="explore-option"><strong>${name}</strong><small>${note}</small></div>`)
              .join("")}
          </div>
          <p class="muted-note">Choosing an OS happens inside Launch, next to the capacity it will use.</p>
        </div>
      </details>`;
  };

  const viewActivity = () => `
    <div class="page-head">
      <div class="grow">
        <p class="eyebrow">History</p>
        <h1 class="page-title">Activity</h1>
        <p class="page-sub">A calm log of what your fleet did. Nothing here is a metric for the sake of it.</p>
      </div>
    </div>
    <div class="recent-list">
      ${activityLog
        .map(
          (row) => `
        <div class="recent-row" role="listitem">
          ${icon(row.icon)}
          <span class="recent-copy"><strong>${row.text}</strong><small>Example entry — preview data</small></span>
          <span class="recent-time">${row.time}</span>
        </div>`,
        )
        .join("")}
    </div>`;

  /* --------------------------------------------------------------- launch */

  const stepBar = () => {
    const steps = [
      [1, "Choose"],
      [2, "Configure"],
      [3, "Review"],
    ];
    return `<div class="stepper">${steps
      .map(([num, label]) => {
        const stateName = state.launch.step === num ? "current" : state.launch.step > num ? "done" : "todo";
        return `<span class="step" data-state="${stateName}"><span class="step-num">${state.launch.step > num ? "✓" : num}</span><span class="step-label">${label}</span></span>`;
      })
      .join(`<span class="step-arrow">${icon("ArrowRight")}</span>`)}</div>`;
  };

  const viewLaunch = () => {
    const launch = state.launch;

    if (launch.phase === "ready") {
      const created = findAgent(launch.createdAgentId);
      return `
        ${stepBar()}
        <div class="ready-panel">
          <h2>${created ? esc(created.name) : "Your agent"} is ready</h2>
          <p class="card-meta">${launch.type === "agent" ? `${esc(launch.runtime)} on a new ${esc(launch.os)} computer` : `${esc(launch.os)} computer`} — example receipt only; nothing was provisioned.</p>
          <div class="card-actions">
            <a class="btn btn-primary" href="#workspace/${launch.type}/${launch.createdAgentId || "patch"}/${launch.type === "agent" ? "chat" : "desktop"}" data-nav>Open workspace</a>
            <button class="btn btn-ghost" type="button" data-action="reset-launch">Launch another</button>
          </div>
        </div>`;
    }

    if (launch.phase === "launching") {
      const steps = ["Reserving capacity", `Installing ${launch.runtime}`, "Connecting your workspace"];
      return `
        ${stepBar()}
        <div class="launching" aria-live="polite">
          <h2 class="page-title" style="font-size:18px">Preparing your ${launch.type}…</h2>
          <div class="progress-steps">
            ${steps
              .map((label, index) => {
                const flag = launch.progress > index ? "done" : launch.progress === index ? "active" : "todo";
                return `<span class="pstep" data-state="${flag}">${flag === "done" ? icon("Check") : flag === "active" ? '<span class="spinner"></span>' : icon("Circle")}${label}</span>`;
              })
              .join("")}
          </div>
          <p class="muted-note">Preview: these steps are simulated. In the app this comes from real provider events.</p>
        </div>`;
    }

    if (launch.step === 1) {
      return `
        ${stepBar()}
        <div class="page-head">
          <div class="grow">
            <h1 class="page-title">What do you want to launch?</h1>
            <p class="page-sub">Agent and computer are siblings — either can exist without the other.</p>
          </div>
        </div>
        <div class="cards">
          <button class="choice-card" type="button" data-action="launch-choose" data-type="agent">
            ${icon("Bot")}<strong>An agent</strong>
            <p>Picks a runtime, creates or reuses a computer, and opens the workspace with chat and terminal.</p>
          </button>
          <button class="choice-card" type="button" data-action="launch-choose" data-type="computer">
            ${icon("Monitor")}<strong>A computer</strong>
            <p>A desktop with terminal and files. No agent required — attach one later if you want.</p>
          </button>
        </div>`;
    }

    if (launch.step === 2) {
      const runtimes = [
        ["Codex", "Terminal-first coding agent"],
        ["Claude Code", "Long-running refactors and review"],
        ["Hermes", "General operator with desktop and files"],
      ];
      const systems = [
        ["Ubuntu Desktop", "Familiar Linux desktop"],
        ["Omarchy", "Tiling desktop for power users"],
        ["Windows", "Bring your own license"],
      ];
      const options = launch.type === "agent" ? runtimes : systems;
      const key = launch.type === "agent" ? "runtime" : "os";
      return `
        ${stepBar()}
        <div class="page-head">
          <div class="grow">
            <h1 class="page-title">Configure</h1>
            <p class="page-sub">One recommended setup. Change anything that matters, ignore the rest.</p>
          </div>
          <button class="btn btn-ghost btn-small" type="button" data-action="launch-back">Back</button>
        </div>
        <div class="launch-grid">
          <div class="form-stack">
            <div class="form-block">
              <h2>${launch.type === "agent" ? "Runtime" : "Operating system"}</h2>
              <div class="radio-row">
                ${options
                  .map(
                    ([name, note]) => `
                  <button class="radio-card" type="button" data-action="launch-pick" data-key="${key}" data-value="${name}" aria-pressed="${launch[key] === name}">
                    <strong>${name}</strong><small>${note}</small>
                  </button>`,
                  )
                  .join("")}
              </div>
            </div>
            <div class="form-block">
              <h2>Name</h2>
              <div class="field">
                <label for="launch-name">${launch.type === "agent" ? "Agent name" : "Computer name"}</label>
                <input class="input" id="launch-name" value="${esc(launch.name)}" data-input="launch-name" />
              </div>
            </div>
            <div class="form-block">
              <h2>Runs on</h2>
              <div class="inline-row">
                <span class="muted-note">${launch.placement === "new" ? "A new Ubuntu Desktop computer (recommended)" : esc(findComputer(launch.placement)?.name || "Existing computer")}</span>
                <span class="chip">${icon("Cpu")}${esc(launch.size)}</span>
                <button class="btn btn-ghost btn-small" type="button" data-action="launch-placement">Change</button>
              </div>
              ${
                launch.type === "agent"
                  ? `<div class="radio-row">
                      <button class="radio-card" type="button" data-action="launch-place" data-value="new" aria-pressed="${launch.placement === "new"}"><strong>New computer</strong><small>Recommended — isolated for this agent</small></button>
                      <button class="radio-card" type="button" data-action="launch-place" data-value="devbox" aria-pressed="${launch.placement === "devbox"}"><strong>devbox</strong><small>Share with Patch (not isolated)</small></button>
                    </div>`
                  : ""
              }
            </div>
            <details class="explore">
              <summary>${icon("ChevronRight")}Advanced — region, image and isolation</summary>
              <div class="explore-body">
                <p class="muted-note">Defaults: nearest region, current image, isolated guest. Nothing to change unless you want to.</p>
              </div>
            </details>
          </div>
          <aside class="estimate">
            <h2>Summary</h2>
            <dl>
              <div class="kv"><dt>Type</dt><dd>${launch.type === "agent" ? "Agent" : "Computer"}</dd></div>
              <div class="kv"><dt>${launch.type === "agent" ? "Runtime" : "OS"}</dt><dd>${esc(launch[key])}</dd></div>
              <div class="kv"><dt>Size</dt><dd>${esc(launch.size)}</dd></div>
              <div class="kv"><dt>Est. cost</dt><dd>Example only</dd></div>
            </dl>
            <button class="btn btn-primary btn-block" type="button" data-action="launch-next">Continue to review</button>
          </aside>
        </div>`;
    }

    const rows =
      launch.type === "agent"
        ? [
            ["Type", "Agent"],
            ["Runtime", launch.runtime],
            ["Name", launch.name],
            ["Runs on", launch.placement === "new" ? `New ${launch.os} computer` : `Existing computer (${launch.placement})`],
            ["Size", launch.size],
            ["Isolation", "Isolated guest — its own OS instance"],
            ["Cost", "Example estimate only — shown as a range in the app"],
          ]
        : [
            ["Type", "Computer"],
            ["OS", launch.os],
            ["Name", launch.name],
            ["Size", launch.size],
            ["Isolation", "Isolated guest — its own OS instance"],
            ["Cost", "Example estimate only — shown as a range in the app"],
          ];
    return `
      ${stepBar()}
      <div class="page-head">
        <div class="grow">
          <h1 class="page-title">Review</h1>
          <p class="page-sub">This is exactly what will be created. Nothing else changes.</p>
        </div>
        <button class="btn btn-ghost btn-small" type="button" data-action="launch-back">Back</button>
      </div>
      <div class="launch-grid">
        <div class="form-block">
          <dl class="review-dl">
            ${rows.map(([label, value]) => `<div class="kv"><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}
          </dl>
          <p class="review-note">Preview only: pressing Launch shows simulated preparation. No provider, credential or billing action occurs.</p>
          <button class="btn btn-primary" type="button" data-action="launch-submit">${icon("Play")}Launch</button>
        </div>
        <aside class="estimate">
          <h2>After launch</h2>
          <p class="muted-note">Opens the ${launch.type === "agent" ? "workspace with chat and terminal" : "desktop"} straight away — no inventory round-trip.</p>
        </aside>
      </div>`;
  };

  /* ------------------------------------------------------------ workspace */

  const railGroups = () => {
    const q = state.search.rail?.trim?.() ?? "";
    const agentList = q
      ? agents.filter((agent) => `${agent.name} ${agent.runtime}`.toLowerCase().includes(q.toLowerCase()))
      : agents;
    const computerList = q
      ? computers.filter((computer) => `${computer.name} ${computer.os}`.toLowerCase().includes(q.toLowerCase()))
      : computers;
    const { view, rest } = route();
    const [kind, id] = [rest[0], rest[1]];

    const group = (title, items, k) => {
      const collapsed = q ? false : state.railCollapsed[k];
      return `
      <div class="rail-group" data-collapsed="${collapsed ? "true" : "false"}">
        <button class="rail-heading rail-toggle" type="button" data-action="toggle-rail-group" data-group="${k}" aria-expanded="${collapsed ? "false" : "true"}">
          ${icon(collapsed ? "ChevronRight" : "ChevronDown")}<span>${title}</span><span class="rail-count">${items.length}</span>
        </button>
        ${
          collapsed
            ? ""
            : items
                .map((item) => {
                  const selected = view === "workspace" && kind === k && id === item.id;
                  const meta = k === "agent" ? item.runtime : item.os;
                  const surface = k === "agent" ? "chat" : "desktop";
                  const pending = k === "computer" && state.pendingResizes[item.id];
                  const pendingDot = pending ? `<span class="rail-pending" title="Resize pending restart"></span>` : "";
                  return `
            <a class="rail-item" href="#workspace/${k}/${item.id}/${surface}" data-nav ${selected ? 'aria-current="true"' : ""}>
              <span class="status-dot" data-state="${esc(item.status)}"></span>
              <span class="rail-copy"><strong>${esc(item.name)}${pendingDot}</strong><small>${esc(meta)} · ${statusWord[item.status] || item.status}</small></span>
            </a>`;
                })
                .join("")
        }
      </div>`;
    };

    return `${group("Agents", agentList, "agent")}${group("Computers", computerList, "computer")}`;
  };

  const renderRich = (text) => {
    let html = esc(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
      const code = body.replace(/\n$/, "");
      return `<div class="code"><div class="code-head"><span>${lang || "text"}</span><button type="button" data-action="chat-copy" data-copy="${esc(code)}">Copy</button></div><pre>${code}</pre></div>`;
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    return html;
  };

  const baseThread = (agent) => [
    {
      type: "assistant",
      time: "22:41",
      text: `Morning. The billing adapter refactor is done on ${agent.computer} — retry policy moved into its own module and the suite is green. Want the short version?`,
    },
    { type: "user", time: "22:42", text: "Yes — three lines. And run the launch tests." },
    {
      type: "assistant",
      time: "22:42",
      text: "1. Extracted `retry-policy`.\n2. The adapter now takes a clock, so backoff is testable.\n3. One regression test locks the 3-attempt behaviour.\n\n```diff\n- if (attempts > 3) throw new Error(\"giving up\");\n+ await retryPolicy.run(task, { attempts: 3, clock });\n```",
    },
    {
      type: "tool",
      time: "22:43",
      title: "Ran the launch test suite",
      cmd: "npm test -- --runInBand src/lib/launch",
      open: false,
      out: [
        "PASS src/lib/launch/__tests__/draft-store.test.ts",
        "PASS src/lib/launch/__tests__/launch-adapter.test.ts",
        "Tests: 45 passed, 45 total",
      ],
    },
    {
      type: "approval",
      time: "22:44",
      title: "Wants to install a dependency",
      detail: "npm install @hivra/retry-policy@2 --save",
      state: "pending",
    },
  ];

  const threadFor = (agent) => {
    if (!state.threads[agent.id]) state.threads[agent.id] = baseThread(agent);
    return state.threads[agent.id];
  };

  const currentAgentId = () => {
    const { view, rest } = route();
    return view === "workspace" && rest[0] === "agent" ? rest[1] : null;
  };

  const chatMessage = (message, index, agent) => {
    if (message.type === "user") {
      return `
        <div class="msg-user">
          <div class="bubble">${renderRich(message.text)}</div>
          <span class="msg-time">${esc(message.time || "")}</span>
        </div>`;
    }
    if (message.type === "tool") {
      return `
        <div class="msg-assistant">
          <span class="avatar">${esc(agent.name[0] || "?")}</span>
          <div class="msg-content">
            <div class="tool-card" data-open="${message.open ? "true" : "false"}">
              <button class="tool-head" type="button" data-action="chat-tool" data-i="${index}" aria-expanded="${message.open ? "true" : "false"}">
                ${icon("Terminal")}
                <span class="tool-title">${esc(message.title)}</span>
                <span class="tool-status">done</span>
                ${icon("ChevronDown")}
              </button>
              ${message.open ? `<div class="tool-body"><div class="tool-cmd">$ ${esc(message.cmd)}</div><pre class="tool-out">${esc(message.out.join("\n"))}</pre></div>` : ""}
            </div>
            <span class="msg-time">${esc(message.time || "")}</span>
          </div>
        </div>`;
    }
    if (message.type === "approval") {
      const pending = message.state === "pending";
      return `
        <div class="msg-assistant">
          <span class="avatar">${esc(agent.name[0] || "?")}</span>
          <div class="msg-content">
            <div class="approval-card" data-state="${esc(message.state)}">
              <div class="approval-head">${icon(pending ? "CircleAlert" : message.state === "approved" ? "Check" : "X")}
                <strong>${esc(message.title)}</strong></div>
              <div class="approval-detail">${esc(message.detail)}</div>
              ${
                pending
                  ? `<div class="approval-actions">
                      <button class="btn btn-primary btn-small" type="button" data-action="chat-approve" data-i="${index}">Approve</button>
                      <button class="btn btn-ghost btn-small" type="button" data-action="chat-deny" data-i="${index}">Deny</button>
                    </div>`
                  : `<div class="approval-resolved">${message.state === "approved" ? "Approved — the command ran (preview)." : "Denied — nothing ran."}</div>`
              }
            </div>
            <span class="msg-time">${esc(message.time || "")}</span>
          </div>
        </div>`;
    }
    return `
      <div class="msg-assistant">
        <span class="avatar">${esc(agent.name[0] || "?")}</span>
        <div class="msg-content">
          ${message.streaming ? `<div class="bubble"><span class="dots" aria-label="Replying"><i></i><i></i><i></i></span></div>` : `<div class="bubble">${renderRich(message.text)}</div>`}
          <div class="msg-foot">
            <span class="msg-time">${esc(message.time || "")}</span>
            ${message.streaming ? "" : `<button class="msg-action" type="button" data-action="chat-copy" data-copy="${esc(message.text || "")}">Copy</button>`}
          </div>
        </div>
      </div>`;
  };

  const chatPane = (agent) => {
    const thread = threadFor(agent);
    const suggestions =
      agent.status === "stopped"
        ? ["Start this agent again", "Show me the last session", "Move it to another computer"]
        : ["Summarise what changed today", "Run the test suite and fix failures", "Open a PR for the current branch"];

    if (!thread.length) {
      return `
        <div class="chat">
          <div class="chat-empty">
            ${icon("MessageSquare")}
            <h2>Start a conversation with ${esc(agent.name)}</h2>
            <p>No project or task needed. Ask about the work, run a command, or hand something over.</p>
            <div class="suggestion-row">
              ${suggestions.map((text) => `<button class="suggestion" type="button" data-action="chat-suggest" data-text="${esc(text)}">${esc(text)}</button>`).join("")}
            </div>
          </div>
          ${chatComposer(agent)}
        </div>`;
    }

    return `
      <div class="chat">
        <div class="chat-log">
          ${thread.map((message, index) => chatMessage(message, index, agent)).join("")}
        </div>
        ${chatComposer(agent)}
      </div>`;
  };

  const chatComposer = (agent) => `
    <div class="composer">
      <div class="composer-box">
        <textarea data-input="chat-draft" rows="1" placeholder="Message ${esc(agent.name)}…" aria-label="Message ${esc(agent.name)}">${esc(state.chat.draft)}</textarea>
        <div class="composer-bar">
          <button class="composer-tool" type="button" data-action="chat-attach">${icon("Folder")}Attach</button>
          <span class="menu">
            <button class="composer-tool" type="button" data-action="toggle-menu" data-menu="model">${icon("Bot")}Runtime default ${icon("ChevronDown")}</button>
            ${
              state.menu === "model"
                ? `<span class="menu-pop">
                    <button type="button" data-action="mock" data-note="Model choice lives here; runtime defaults come from Manage.">Runtime default</button>
                    <button type="button" data-action="mock" data-note="Per-agent model selection is proposed in this overhaul.">Choose in Manage…</button>
                  </span>`
                : ""
            }
          </span>
          <span class="composer-spacer"></span>
          <span class="composer-hint-inline">Enter to send · Shift+Enter for a new line</span>
          <button class="btn btn-primary btn-small" type="button" data-action="chat-send" ${state.chat.draft.trim() ? "" : 'aria-disabled="true"'}>${icon("ArrowUp")}Send</button>
        </div>
      </div>
      <p class="composer-foot">Preview only — messages are simulated and nothing is sent.</p>
    </div>`;

  const termPane = () => {
    if (state.term.detached) {
      return `
        <div class="term">
          <div class="term-bar">
            <span class="term-session" aria-selected="true">${icon("Terminal")} main — zsh</span>
            <span class="term-spacer"></span>
            <button class="term-btn" type="button" data-action="term-reattach">${icon("ArrowRight")} Reattach</button>
          </div>
          <div class="term-detached">
            <span class="chip">${icon("Check")}Session still running</span>
            <strong style="color:#fdfcf9">Detached — the command keeps going.</strong>
            <p>Closing or leaving this pane does not stop the run. Reattach any time and scrollback is intact.</p>
          </div>
        </div>`;
    }
    const body =
      state.term.active === "main"
        ? `<span class="dim">Last login: Tue 16 Sep 22:41 on ttys004</span>
<span class="prompt">patch@devbox</span>:~$ git pull<br />Already up to date.
<span class="prompt">patch@devbox</span>:~$ npm test -- --runInBand src/lib/launch<br /><span class="ok">PASS</span> src/lib/launch/__tests__/draft-store.test.ts
<span class="ok">PASS</span> src/lib/launch/__tests__/launch-adapter.test.ts
Tests: <span class="ok">45 passed</span>, 45 total
<span class="prompt">patch@devbox</span>:~$ <span class="cursor"></span>`
        : `<span class="dim">New session on devbox</span>
<span class="prompt">patch@devbox</span>:~$ <span class="cursor"></span>`;
    return `
      <div class="term">
        <div class="term-bar">
          ${state.term.sessions
            .map(
              (session) =>
                `<button class="term-session" type="button" data-action="term-session" data-session="${session}" aria-selected="${state.term.active === session}">${icon("Terminal")} ${session}</button>`,
            )
            .join("")}
          <button class="term-session" type="button" data-action="term-new">${icon("Plus")}</button>
          <span class="term-spacer"></span>
          <button class="term-btn" type="button" data-action="term-detach">${icon("X")} Detach</button>
        </div>
        <div class="term-body">${body}</div>
      </div>`;
  };

  const filesPane = () => `
    <div class="files">
      <p class="files-path">~ / projects / hivra</p>
      <div class="files-list">
        ${[
          ["Folder", "src", "—"],
          ["Folder", "dashboard", "—"],
          ["Check", "package.json", "4.1 KB"],
          ["Check", "README.md", "12 KB"],
          ["Folder", "node_modules", "—"],
        ]
          .map(([ic, name, size]) => `<div class="file-row">${icon(ic)}<span>${name}</span><small>${size}</small></div>`)
          .join("")}
      </div>
      <p class="muted-note">Files attach to the selected computer. Editing here writes to the real filesystem in the app.</p>
    </div>`;

  const placeholderPane = (surface, resource) => `
    <div class="placeholder">
      ${icon("PanelRight")}
      <strong>${esc(surface)} is not part of this preview</strong>
      <p>In the app, ${esc(resource.name)} opens ${esc(surface.toLowerCase())} here, inside the same workspace — not as a separate page or tab.</p>
    </div>`;

  const desktopPane = (resource, kind) => `
    <div class="placeholder">
      ${icon("Monitor")}
      <strong>Desktop streams here in the live app</strong>
      <p>The overhaul keeps ${kind === "computer" ? "desktop-first" : "chat-first"} layout. This preview skips the stream, but keyboard, pointer and resize stay inside this pane.</p>
    </div>`;

  const viewWorkspace = () => {
    const { rest } = route();
    const kind = rest[0] === "computer" ? "computer" : "agent";
    const id = rest[1];
    const resource = kind === "agent" ? findAgent(id) : findComputer(id);
    if (!resource) {
      return `<div class="placeholder">${icon("CircleAlert")}<strong>That resource is not in the example fleet</strong><p>Pick one from the rail, or start from Home.</p></div>`;
    }
    const surfaces = surfaceTabs(kind).map((surface) => surface.id);
    const requested = rest[2] || (kind === "agent" ? "chat" : "desktop");
    const active = surfaces.includes(requested) ? requested : surfaces[0];
    const more = moreSurfaces(kind);

    const tabs = [
      ...surfaceTabs(kind).map((surface) => {
        const href = `#workspace/${kind}/${resource.id}/${surface.id}`;
        return `<a class="tab" href="${href}" data-nav role="tab" aria-selected="${active === surface.id}">${icon(surface.icon)}${surface.label}</a>`;
      }),
      `<span class="menu tab-more">
        <button class="tab" type="button" data-action="toggle-menu" data-menu="surfaces" aria-expanded="${state.menu === "surfaces"}">More ${icon("ChevronDown")}</button>
        ${state.menu === "surfaces" ? `<span class="menu-pop">${more.map((surface) => `<a href="#workspace/${kind}/${resource.id}/${surface.id}" data-nav>${surface.label}</a>`).join("")}</span>` : ""}
      </span>`,
    ].join("");

    const context =
      kind === "agent"
        ? `
        ${icon("Bot")}
        <h1>${esc(resource.name)}</h1>
        <span class="context-chips">
          <span class="chip">${esc(resource.runtime)}</span>
          <span class="chip">${icon("Laptop")}${esc(resource.computer)}</span>
          ${statusEl(resource.status)}
        </span>`
        : `
        ${icon("Laptop")}
        <h1>${esc(resource.name)}</h1>
        <span class="context-chips">
          <span class="chip">${esc(resource.os)}</span>
          <span class="chip">${esc(resource.size)}</span>
          ${state.pendingResizes[resource.id] ? `<span class="chip chip-pending">${icon("SlidersHorizontal")}Resize pending · applies at restart</span>` : ""}
          ${statusEl(resource.status)}
        </span>`;

    const pane =
      active === "chat" && kind === "agent"
        ? chatPane(resource)
        : active === "terminal"
          ? termPane()
          : active === "files"
            ? `<div class="pane">${filesPane()}</div>`
            : active === "desktop"
              ? `<div class="pane">${desktopPane(resource, kind)}</div>`
              : `<div class="pane">${placeholderPane(active, resource)}</div>`;

    return `
      <div class="workspace" data-rail="${state.railOpen ? "open" : "closed"}">
        <aside class="rail" aria-label="Fleet">
          <div class="rail-head">
            <h2>Your fleet</h2>
            <button class="btn btn-ghost btn-small" type="button" data-action="start-launch" data-type="agent">${icon("Plus")}New</button>
          </div>
          <label class="rail-search">${icon("Search")}<input type="search" placeholder="Filter fleet" value="${esc(state.search.rail || "")}" data-input="rail" aria-label="Filter fleet" /></label>
          <div id="rail-groups">${railGroups()}</div>
        </aside>
        <section class="work">
          <header class="context-bar">
            <button class="btn btn-ghost btn-small fleet-toggle" type="button" data-action="toggle-rail">${icon("PanelRight")}Fleet</button>
            <span class="context-title">${context}</span>
            <span class="context-actions">
              ${
                kind === "agent"
                  ? `<span class="menu">
                      <button class="btn btn-ghost btn-small" type="button" data-action="toggle-menu" data-menu="sessions" aria-expanded="${state.menu === "sessions"}">
                        ${icon("MessageSquare")}${esc(state.session.name)}${icon("ChevronDown")}
                      </button>
                      ${
                        state.menu === "sessions"
                          ? `<span class="menu-pop">
                              ${state.session.list
                                .map((name) => `<button type="button" data-action="session-pick" data-session="${esc(name)}"${name === state.session.name ? ' aria-current="true"' : ""}>${esc(name)}</button>`)
                                .join("")}
                              <button type="button" data-action="session-new">New chat…</button>
                            </span>`
                          : ""
                      }
                    </span>`
                  : ""
              }
              <button class="btn btn-ghost btn-small" type="button" data-action="start-launch" data-type="agent">${icon("Plus")}New</button>
              <button class="btn btn-ghost btn-small" type="button" data-action="open-manage" data-kind="${kind}" data-id="${resource.id}">${icon("SlidersHorizontal")}Manage</button>
            </span>
          </header>
          <nav class="tabs" role="tablist" aria-label="Surfaces">${tabs}</nav>
          <div class="${active === "chat" || active === "terminal" ? "pane pane-fill" : ""}">${pane}</div>
        </section>
      </div>`;
  };

  const viewPlaceholder = (key) => {
    const titles = {
      infrastructure: "Infrastructure",
      settings: "Settings",
      applications: "Applications",
      help: "Help",
    };
    const title = titles[key] || "Not in this preview";
    return `
      <div class="page-head">
        <div class="grow">
          <p class="eyebrow">Preview</p>
          <h1 class="page-title">${title}</h1>
        </div>
      </div>
      <div class="placeholder">
        ${icon("PanelRight")}
        <strong>${title} keeps its current page</strong>
        <p>This overhaul only touches Home, Agents, Computers, Launch and the agent workspace. ${title} is listed so navigation stays truthful.</p>
      </div>`;
  };

  /* ------------------------------------------------------------- overlay */

  const renderDrawer = () => {
    if (!state.drawer) return "";
    const [kind, id] = state.drawer.split(":");
    const resource = kind === "agent" ? findAgent(id) : findComputer(id);
    if (!resource) return "";
    const isRunning = resource.status === "running";
    return `
      <div class="scrim" data-action="close-manage"></div>
      <aside class="drawer" role="dialog" aria-label="Manage ${esc(resource.name)}">
        <div class="drawer-head">
          ${icon(kind === "agent" ? "Bot" : "Laptop")}
          <h2>Manage ${esc(resource.name)}</h2>
          <button class="icon-btn" type="button" data-action="close-manage" aria-label="Close">${icon("X")}</button>
        </div>
        <div class="drawer-body">
          <div class="drawer-section">
            <h3>Power</h3>
            <div class="drawer-row">
              <span>${statusEl(resource.status)}</span>
              <span class="drawer-actions">
                <button class="btn btn-ghost btn-small" type="button" data-action="manage-restart">Restart</button>
                ${isRunning ? `<button class="btn btn-ghost btn-small" type="button" data-action="manage-stop">Stop</button>` : `<button class="btn btn-ghost btn-small" type="button" data-action="manage-start">Start</button>`}
              </span>
            </div>
          </div>

          ${
            kind === "computer"
              ? `
          <div class="drawer-section">
            <h3>Capacity</h3>
            <div class="drawer-row"><span class="label">Current</span><span>${esc(resource.size)}</span></div>
            ${
              state.pendingResizes[id]
                ? `<div class="pending-banner">
                    <div><strong>Pending resize</strong><span>${state.pendingResizes[id].cpu} vCPU · ${state.pendingResizes[id].ram} GB — applies at the next restart.</span></div>
                    <button class="btn btn-ghost btn-small" type="button" data-action="manage-cancel">Cancel</button>
                  </div>`
                : ""
            }
            ${
              state.manage.resize
                ? `
            <div class="resize-editor">
              <div class="stepper-row">
                <span class="label">vCPU</span>
                <span class="stepper">
                  <button type="button" data-action="manage-step" data-key="cpu" data-delta="-1" aria-label="Fewer vCPU">−</button>
                  <span class="stepper-value">${state.manage.resize.cpu}</span>
                  <button type="button" data-action="manage-step" data-key="cpu" data-delta="1" aria-label="More vCPU">+</button>
                </span>
              </div>
              <div class="stepper-row">
                <span class="label">Memory</span>
                <span class="stepper">
                  <button type="button" data-action="manage-step" data-key="ram" data-delta="-2" aria-label="Less memory">−</button>
                  <span class="stepper-value">${state.manage.resize.ram} GB</span>
                  <button type="button" data-action="manage-step" data-key="ram" data-delta="2" aria-label="More memory">+</button>
                </span>
              </div>
              <div class="preset-row">
                ${[["Small", 2, 4], ["Medium", 4, 8], ["Large", 8, 16]]
                  .map(([label, cpu, ram]) => `<button class="preset" type="button" data-action="manage-preset" data-cpu="${cpu}" data-ram="${ram}" aria-pressed="${state.manage.resize.cpu === cpu && state.manage.resize.ram === ram}">${label}<small>${cpu} vCPU · ${ram} GB</small></button>`)
                  .join("")}
              </div>
              <p class="muted-note">New capacity applies at the next restart and does not change the running session. Example rates only in this preview.</p>
              <div class="drawer-actions">
                <button class="btn btn-primary btn-small" type="button" data-action="manage-apply">Apply change</button>
                <button class="btn btn-ghost btn-small" type="button" data-action="manage-resize-close">Keep current</button>
              </div>
            </div>`
                : `<div class="drawer-row"><span class="label">Resize</span><button class="btn btn-ghost btn-small" type="button" data-action="manage-resize-open">Change size</button></div>`
            }
          </div>

          <div class="drawer-section">
            <h3>Disk</h3>
            <div class="drawer-row disk-row">
              <span class="disk-bar"><span class="disk-fill" style="width:${Math.round((resource.diskUsed / resource.diskTotal) * 100)}%"></span></span>
              <span class="muted-note">${resource.diskUsed} GB of ${resource.diskTotal} GB used</span>
              <button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Disk expansion is queued and applies without reinstalling the OS.">Expand</button>
            </div>
          </div>

          <div class="drawer-section">
            <h3>Snapshots</h3>
            <div class="snapshot-row"><span><strong>Yesterday 22:10</strong><small>manual · before resize</small></span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Restore reverts the disk to this snapshot after a confirmation.">Restore</button></div>
            <div class="snapshot-row"><span><strong>Sep 12 · automatic</strong><small>daily backup</small></span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Restore reverts the disk to this snapshot after a confirmation.">Restore</button></div>
            <button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="A snapshot captures the whole disk; you keep three by default.">Create snapshot</button>
          </div>

          <div class="drawer-section">
            <h3>Recovery</h3>
            <div class="drawer-row"><span>Repair runtime and services</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Repair restarts guest services and fixes common boot issues.">Repair</button></div>
            <div class="drawer-row"><span>Rebuild from the OS image</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Rebuild replaces the disk; snapshots stay available.">Rebuild</button></div>
          </div>`
              : `
          <div class="drawer-section">
            <h3>Runtime</h3>
            <div class="drawer-row"><span class="label">Runtime</span><span>${esc(resource.runtime)}</span></div>
            <div class="drawer-row"><span>Model</span><span class="drawer-actions"><span class="muted-note">Runtime default</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Per-agent model choice is proposed in the overhaul and lands here.">Change</button></span></div>
            <div class="drawer-row"><span>Restart the runtime only</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Restarting the runtime keeps the computer and its files untouched.">Restart runtime</button></div>
          </div>

          <div class="drawer-section">
            <h3>Computer</h3>
            <div class="drawer-row"><span class="label">Runs on</span><a href="#workspace/computer/${esc(resource.computer)}/desktop" data-nav>${esc(resource.computer)}</a></div>
            <div class="drawer-row"><span>Move to another computer</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Move is an explicit migration with a review step; never silent.">Move…</button></div>
          </div>

          <div class="drawer-section">
            <h3>Access</h3>
            <div class="drawer-row">
              <span>Telegram bridge</span>
              <span class="drawer-actions">
                <span class="chip">${state.manage.telegram ? "Connected" : "Off"}</span>
                <button class="btn btn-ghost btn-small" type="button" data-action="manage-telegram">${state.manage.telegram ? "Disconnect" : "Connect"}</button>
              </span>
            </div>
            <div class="drawer-row"><span>Skills enabled</span><span class="drawer-actions"><span class="muted-note">4 of 6</span><button class="btn btn-ghost btn-small" type="button" data-action="mock" data-note="Skills are per-agent and reviewable before enabling.">Manage</button></span></div>
          </div>`
          }

          <div class="drawer-section">
            <h3>Name</h3>
            <div class="rename-row">
              <input class="input" type="text" data-input="manage-rename" value="${esc(state.manage.renameDraft || resource.name)}" aria-label="Name" />
              <button class="btn btn-ghost btn-small" type="button" data-action="manage-rename-save">Save</button>
            </div>
          </div>

          <div class="danger-zone">
            <strong style="font-size:13.5px">Danger zone</strong>
            <p>${kind === "computer" ? "Destroy deletes this computer and its disk. Snapshots are removed with it." : "Remove detaches this agent from its computer. The computer and its files stay."} Type <strong>${esc(resource.name)}</strong> to confirm — preview only.</p>
            <div class="rename-row">
              <input class="input" type="text" data-input="manage-destroy" placeholder="${esc(resource.name)}" value="${esc(state.manage.destroyInput)}" aria-label="Type the name to confirm" />
              <button class="btn btn-danger btn-small" type="button" data-action="manage-destroy" ${state.manage.destroyInput === resource.name ? "" : "disabled"}>${kind === "computer" ? "Destroy" : "Remove"}</button>
            </div>
          </div>
        </div>
      </aside>`;
  };

  const switcherResults = () => {
    const q = state.switcher.query.trim().toLowerCase();
    const match = (item) => !q || `${item.name} ${item.runtime || item.os || ""}`.toLowerCase().includes(q);
    const agentHits = agents.filter(match);
    const computerHits = computers.filter(match);
    if (!agentHits.length && !computerHits.length) {
      return `<div class="switcher-empty">Nothing matches “${esc(state.switcher.query)}”.</div>`;
    }
    const row = (item, kind) => {
      const surface = kind === "agent" ? "chat" : "desktop";
      return `<a class="switcher-item" href="#workspace/${kind}/${item.id}/${surface}" data-nav data-switcher-item>
        <span class="status-dot" data-state="${esc(item.status)}"></span>
        <span class="grow"><strong>${esc(item.name)}</strong><small>${esc(kind === "agent" ? `${item.runtime} · ${item.computer}` : `${item.os} · ${item.size}`)}</small></span>
        <small>${statusWord[item.status] || item.status}</small>
      </a>`;
    };
    return `
      ${agentHits.length ? `<p class="switcher-heading">Agents</p>${agentHits.map((item) => row(item, "agent")).join("")}` : ""}
      ${computerHits.length ? `<p class="switcher-heading">Computers</p>${computerHits.map((item) => row(item, "computer")).join("")}` : ""}`;
  };

  const renderSwitcher = () => {
    if (!state.switcher.open) return "";
    return `
      <dialog class="switcher" id="switcher" aria-label="Search fleet">
        <div class="switcher-search">${icon("Search")}
          <input id="switcher-input" type="text" data-input="switcher" placeholder="Search agents and computers…" value="${esc(state.switcher.query)}" autocomplete="off" />
          <span class="kbd">Esc</span>
        </div>
        <div class="switcher-results">${switcherResults()}</div>
        <div class="switcher-foot"><span class="grow">Enter opens the first match · ⌘K anywhere</span><span class="kbd">Preview data</span></div>
      </dialog>`;
  };

  /* ---------------------------------------------------------------- render */

  const render = () => {
    const app = $("#app");
    if (!app) return;
    const { view } = route();
    app.dataset.sidebar = state.sidebar;
    app.dataset.mobileNav = state.mobileNav ? "open" : "closed";

    let content;
    if (view === "home") content = viewHome(false);
    else if (view === "home-empty") content = viewHome(true);
    else if (view === "agents") content = viewAgents();
    else if (view === "computers") content = viewComputers();
    else if (view === "launch") content = viewLaunch();
    else if (view === "workspace") content = viewWorkspace();
    else if (view === "activity") content = viewActivity();
    else content = viewPlaceholder(view);

    const bare = view === "workspace";
    app.innerHTML = `
      ${renderSidebar()}
      ${state.mobileNav ? '<div class="scrim" data-action="toggle-mobile-nav"></div>' : ""}
      <div class="frame">
        ${renderMobileBar()}
        <main id="main" class="main${bare ? " main-bare" : ""}" tabindex="-1">${bare ? content : `<div class="main-narrow">${content}</div>`}</main>
        ${renderBottomNav()}
      </div>`;

    const overlay = $("#overlay-root");
    if (overlay) overlay.innerHTML = `${renderDrawer()}${renderSwitcher()}`;
    const switcher = $("#switcher");
    if (switcher) {
      if (typeof switcher.showModal === "function") {
        try {
          if (!switcher.open) switcher.showModal();
        } catch {
          switcher.setAttribute("open", "");
        }
      } else {
        switcher.setAttribute("open", "");
      }
      $("#switcher-input")?.focus?.();
    }
    syncStrip();
  };

  const syncStrip = () => {
    const { view } = route();
    document.querySelectorAll(".preview-strip .strip-link").forEach((link) => {
      const firstRun = link.getAttribute("href") === "#home-empty";
      const active = firstRun ? view === "home-empty" : view === "home" || view === "agents";
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };

  /* ---------------------------------------------------------------- events */

  const closeSwitcher = () => {
    const switcher = $("#switcher");
    if (switcher && typeof switcher.close === "function") {
      try {
        switcher.close();
      } catch {
        /* jsdom without dialog support: the re-render below removes it. */
      }
    }
    state.switcher = { open: false, query: "", cursor: 0 };
    render();
  };

  const finishLaunch = () => {
    const launch = state.launch;
    if (launch.createdAgentId) return;
    const id = launch.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "new-agent";
    if (launch.type === "agent") {
      if (!agents.some((agent) => agent.id === id)) {
        agents.unshift({
          id,
          name: launch.name.trim() || "New agent",
          runtime: launch.runtime,
          computer: launch.placement === "new" ? "devbox" : launch.placement,
          status: "running",
          activity: "Just launched — preparing its first task",
          lastActive: "Now",
        });
      }
      launch.createdAgentId = id;
    } else {
      if (!computers.some((computer) => computer.id === id)) {
        computers.unshift({
          id,
          name: launch.name.trim() || "new-computer",
          os: launch.os,
          size: launch.size,
          status: "running",
          lastActive: "Now",
        });
      }
      launch.createdAgentId = id;
    }
    launch.phase = "ready";
    render();
  };

  const runLaunchProgress = () => {
    const launch = state.launch;
    launch.phase = "launching";
    launch.progress = 0;
    render();
    const advance = () => {
      if (launch.phase !== "launching") return;
      launch.progress += 1;
      if (launch.progress >= 3) finishLaunch();
      else {
        render();
        window.setTimeout(advance, 300);
      }
    };
    window.setTimeout(advance, 300);
  };

  document.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");

    if (actionEl) {
      const action = actionEl.dataset.action;
      const kind = actionEl.dataset.kind;
      const id = actionEl.dataset.id;
      const resolveApproval = (resolution) => {
        const agent = findAgent(currentAgentId());
        if (!agent) return;
        const message = threadFor(agent)[Number(actionEl.dataset.i)];
        if (!message || message.type !== "approval") return;
        message.state = resolution;
        toast(resolution === "approved" ? "Approved — the command ran (preview)." : "Denied — nothing ran (preview).");
        render();
      };
      const handlers = {
        "toggle-sidebar": () => {
          state.sidebar = state.sidebar === "expanded" ? "collapsed" : "expanded";
          writeStore("preview-sidebar", state.sidebar);
          render();
        },
        "toggle-mobile-nav": () => {
          state.mobileNav = !state.mobileNav;
          render();
        },
        "toggle-rail": () => {
          state.railOpen = !state.railOpen;
          render();
        },
        "toggle-theme": () => {
          const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
          document.documentElement.dataset.theme = next;
          writeStore("preview-theme", next);
        },
        "open-switcher": () => {
          state.switcher = { open: true, query: "", cursor: 0 };
          render();
        },
        "toggle-menu": () => {
          const key = actionEl.dataset.menu;
          state.menu = state.menu === key ? null : key;
          render();
        },
        "open-manage": () => {
          state.drawer = `${kind}:${id}`;
          state.manage = { resize: null, destroyInput: "", renameDraft: "", telegram: state.manage.telegram };
          render();
        },
        "close-manage": () => {
          state.drawer = null;
          state.manage = { resize: null, destroyInput: "", renameDraft: "", telegram: state.manage.telegram };
          render();
        },
        "set-filter": () => {
          state.filter[actionEl.dataset.scope] = actionEl.dataset.value;
          render();
        },
        "start-launch": () => {
          state.launch.step = 2;
          state.launch.type = actionEl.dataset.type || "agent";
          state.launch.phase = "form";
          navigate("#launch");
        },
        "launch-choose": () => {
          state.launch.type = actionEl.dataset.type;
          state.launch.step = 2;
          render();
        },
        "launch-back": () => {
          state.launch.step = Math.max(1, state.launch.step - 1);
          render();
        },
        "launch-pick": () => {
          state.launch[actionEl.dataset.key] = actionEl.dataset.value;
          render();
        },
        "launch-place": () => {
          state.launch.placement = actionEl.dataset.value;
          render();
        },
        "launch-placement": () => {
          toast("Placement options are listed right below this row.");
        },
        "launch-next": () => {
          state.launch.step = 3;
          render();
        },
        "launch-submit": () => {
          runLaunchProgress();
        },
        "reset-launch": () => {
          state.launch = { ...state.launch, step: 1, phase: "form", progress: 0, createdAgentId: null };
          render();
        },
        "chat-send": () => {
          const agent = findAgent(currentAgentId());
          if (!agent) return;
          const draft = state.chat.draft.trim();
          if (!draft) {
            toast("Type a message first — then this button sends it.");
            return;
          }
          const thread = threadFor(agent);
          thread.push({ type: "user", text: draft, time: "Now" });
          const reply = { type: "assistant", text: "", streaming: true, time: "Now" };
          thread.push(reply);
          state.chat.draft = "";
          state.chat.streaming = true;
          render();
          window.setTimeout(() => {
            reply.streaming = false;
            reply.text = `Done — the suite is still green. This is a preview reply from ${agent.name}; nothing was sent.`;
            state.chat.streaming = false;
            if (currentAgentId() === agent.id) render();
          }, 900);
        },
        "chat-tool": () => {
          const agent = findAgent(currentAgentId());
          if (!agent) return;
          const message = threadFor(agent)[Number(actionEl.dataset.i)];
          if (message) message.open = !message.open;
          render();
        },
        "chat-approve": () =>
          resolveApproval("approved"),
        "chat-deny": () =>
          resolveApproval("denied"),
        "chat-copy": () => {
          try {
            navigator.clipboard?.writeText?.(actionEl.dataset.copy || "");
          } catch {
            /* Clipboard is optional in the preview. */
          }
          toast("Copied — preview only.");
        },
        "chat-attach": () => {
          toast("Attach picks files from the selected computer — preview only.");
        },
        "chat-suggest": () => {
          state.chat.draft = actionEl.dataset.text || "";
          render();
          document.querySelector('[data-input="chat-draft"]')?.focus?.();
        },
        "session-pick": () => {
          const agent = findAgent(currentAgentId());
          state.session.name = actionEl.dataset.session;
          state.menu = null;
          if (agent) delete state.threads[agent.id];
          render();
        },
        "session-new": () => {
          const agent = findAgent(currentAgentId());
          state.session.name = "New chat";
          state.menu = null;
          if (agent) state.threads[agent.id] = [];
          render();
        },
        "toggle-rail-group": () => {
          const group = actionEl.dataset.group;
          state.railCollapsed[group] = !state.railCollapsed[group];
          render();
        },
        "manage-resize-open": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const computer = dkind === "computer" ? findComputer(did) : null;
          if (!computer) return;
          state.manage.resize = { cpu: computer.cpu, ram: computer.ram };
          render();
        },
        "manage-resize-close": () => {
          state.manage.resize = null;
          render();
        },
        "manage-step": () => {
          const resize = state.manage.resize;
          if (!resize) return;
          const key = actionEl.dataset.key;
          const delta = Number(actionEl.dataset.delta);
          const min = key === "cpu" ? 1 : 2;
          const max = key === "cpu" ? 8 : 32;
          resize[key] = Math.min(max, Math.max(min, resize[key] + delta));
          render();
        },
        "manage-preset": () => {
          state.manage.resize = { cpu: Number(actionEl.dataset.cpu), ram: Number(actionEl.dataset.ram) };
          render();
        },
        "manage-apply": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          if (dkind !== "computer" || !state.manage.resize) return;
          state.pendingResizes[did] = { ...state.manage.resize };
          state.manage.resize = null;
          toast("Resize queued — it applies at the next restart.");
          render();
        },
        "manage-cancel": () => {
          const [, did] = (state.drawer || "").split(":");
          delete state.pendingResizes[did];
          toast("Pending resize cancelled.");
          render();
        },
        "manage-restart": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
          if (!resource) return;
          const revert = resource.status === "stopped" ? "running" : resource.status;
          resource.status = "starting";
          toast("Restarting — the status updates when it is back.");
          render();
          window.setTimeout(() => {
            resource.status = revert;
            render();
          }, 1300);
        },
        "manage-start": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
          if (!resource) return;
          resource.status = "starting";
          toast("Starting — the status updates when it is ready.");
          render();
          window.setTimeout(() => {
            resource.status = "running";
            render();
          }, 1300);
        },
        "manage-stop": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
          if (!resource) return;
          resource.status = "stopped";
          toast("Stopped. Files and disk are preserved.");
          render();
        },
        "manage-rename-save": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
          if (!resource) return;
          const name = state.manage.renameDraft.trim();
          if (name) resource.name = name;
          state.manage.renameDraft = "";
          toast(`Renamed to ${resource.name}.`);
          render();
        },
        "manage-destroy": () => {
          const [dkind, did] = (state.drawer || "").split(":");
          const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
          if (!resource || state.manage.destroyInput !== resource.name) return;
          state.drawer = null;
          toast("Preview only — the app confirms again and reconciles provider residue.");
          render();
        },
        "manage-telegram": () => {
          state.manage.telegram = !state.manage.telegram;
          toast(state.manage.telegram ? "Telegram bridge connected (preview)." : "Telegram bridge disconnected (preview).");
          render();
        },
        "term-new": () => {
          const next = `session-${state.term.sessions.length + 1}`;
          state.term.sessions.push(next);
          state.term.active = next;
          render();
        },
        "term-session": () => {
          state.term.active = actionEl.dataset.session;
          render();
        },
        "term-detach": () => {
          state.term.detached = true;
          toast("Detached — the run keeps going.");
          render();
        },
        "term-reattach": () => {
          state.term.detached = false;
          render();
        },
        mock: () => {
          toast(actionEl.dataset.note || "Preview only — no real action taken.");
        },
      };
      if (handlers[action]) {
        event.preventDefault();
        handlers[action]();
        if (!["toggle-menu", "open-switcher"].includes(action) && state.menu) {
          state.menu = null;
        }
        return;
      }
    }

    const navLink = event.target.closest('a[href^="#"]');
    if (navLink) {
      event.preventDefault();
      closeSwitcher();
      state.menu = null;
      state.mobileNav = false;
      navigate(navLink.getAttribute("href"));
      return;
    }

    if (!event.target.closest(".menu") && state.menu) {
      state.menu = null;
      render();
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target.closest("[data-input]");
    if (!input) return;
    const key = input.dataset.input;
    if (key === "switcher") {
      state.switcher.query = input.value;
      render();
      const next = document.querySelector("#switcher-input");
      next?.focus?.();
      try {
        next?.setSelectionRange?.(input.value.length, input.value.length);
      } catch {
        /* ignore */
      }
      return;
    }
    if (key === "agents" || key === "computers" || key === "rail") {
      state.search[key] = input.value;
      if (key === "agents") {
        const rows = document.querySelector("#agents-rows");
        if (rows) rows.innerHTML = agentRows();
      } else if (key === "computers") {
        const rows = document.querySelector("#computers-rows");
        if (rows) rows.innerHTML = computerRows();
      } else {
        const groups = document.querySelector("#rail-groups");
        if (groups) groups.innerHTML = railGroups();
      }
      return;
    }
    if (key === "chat-draft") {
      state.chat.draft = input.value;
      const button = document.querySelector('[data-action="chat-send"]');
      button?.toggleAttribute("aria-disabled", input.value.trim() === "");
      return;
    }
    if (key === "launch-name") {
      state.launch.name = input.value;
      return;
    }
    if (key === "manage-rename") {
      state.manage.renameDraft = input.value;
      return;
    }
    if (key === "manage-destroy") {
      state.manage.destroyInput = input.value;
      const [dkind, did] = (state.drawer || "").split(":");
      const resource = dkind === "agent" ? findAgent(did) : findComputer(did);
      const button = document.querySelector('[data-action="manage-destroy"]');
      if (button && resource) button.toggleAttribute("disabled", input.value !== resource.name);
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      state.switcher = { open: true, query: "", cursor: 0 };
      render();
      return;
    }
    if (event.key === "Escape") {
      if (state.switcher.open) closeSwitcher();
      if (state.drawer) {
        state.drawer = null;
        render();
      }
      if (state.mobileNav) {
        state.mobileNav = false;
        render();
      }
      return;
    }
    if (state.switcher.open && event.key === "Enter") {
      event.preventDefault();
      document.querySelector("[data-switcher-item]")?.click();
      return;
    }
    if (event.key === "Enter" && event.target?.dataset?.input === "chat-draft" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector('[data-action="chat-send"]')?.click();
    }
  });

  window.addEventListener("hashchange", render);
  window.addEventListener("popstate", render);

  /* ------------------------------------------------------------------ boot */

  const boot = () => {
    document.querySelectorAll("[data-theme-icon='dark']").forEach((el) => {
      el.innerHTML = icons.Sun || "";
    });
    document.querySelectorAll("[data-theme-icon='light']").forEach((el) => {
      el.innerHTML = icons.Moon || "";
    });
    render();
  };

  /* The script runs deferred (or is evaluated after parsing in tests), so the
     static shell already exists when this executes. */
  boot();
})();
