/* Standalone design study. All resources are fictional; no network or provisioning calls. */
(() => {
  "use strict";
  const icons = window.HIVRA_ICONS;
  const icon = (name) => icons[name] || icons.Circle;
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const agents = [
    {
      id: "atlas",
      name: "Atlas",
      initial: "A",
      runtime: "Hermes",
      role: "Research & writing",
      computer: "everyday",
      status: "Available",
      state: "ready",
      last: "Research notes",
      purpose:
        "A place to think through ideas, work with research, and keep the conversation going.",
    },
    {
      id: "patch",
      name: "Patch",
      initial: "P",
      runtime: "Claude Code",
      role: "Development",
      computer: "devbox",
      status: "Native interface",
      state: "native",
      last: "Website development",
      purpose:
        "Open the native coding interface with your project and tools in context.",
    },
    {
      id: "scout",
      name: "Scout",
      initial: "S",
      runtime: "Hermes",
      role: "Daily operations",
      computer: "operations",
      status: "Needs attention",
      state: "blocked",
      last: "Morning briefing",
      purpose: "Keep everyday research and operating notes together.",
    },
  ];
  const computers = [
    {
      id: "everyday",
      name: "Everyday Linux",
      os: "Ubuntu desktop",
      initial: "E",
      type: "Desktop",
      state: "ready",
      status: "Available",
      cpu: "4 vCPU",
      memory: "8 GB",
      storage: "80 GB",
      agents: ["atlas"],
    },
    {
      id: "devbox",
      name: "Dev box",
      os: "Ubuntu terminal",
      initial: "D",
      type: "Terminal",
      state: "ready",
      status: "Available",
      cpu: "4 vCPU",
      memory: "8 GB",
      storage: "80 GB",
      agents: ["patch"],
    },
    {
      id: "operations",
      name: "Operations Linux",
      os: "Ubuntu terminal",
      initial: "O",
      type: "Terminal",
      state: "ready",
      status: "Available",
      cpu: "2 vCPU",
      memory: "4 GB",
      storage: "40 GB",
      agents: ["scout"],
    },
    {
      id: "sandbox",
      name: "Sandbox",
      os: "Ubuntu desktop",
      initial: "S",
      type: "Desktop",
      state: "stopped",
      status: "Stopped",
      cpu: "2 vCPU",
      memory: "4 GB",
      storage: "40 GB",
      agents: [],
    },
  ];
  const state = {
    view: "home",
    id: null,
    tab: "conversation",
    inspector: false,
    mobile: false,
    query: "",
    filter: "all",
    drafts: {},
    launch: {
      step: 1,
      type: "agent",
      name: "Research agent",
      autoName: true,
      location: "Hivra Cloud (example)",
      showLocation: false,
      runtime: "Hermes",
      profile: "Ubuntu desktop",
      size: "Small · 2 vCPU / 4 GB",
      region: "Automatic",
      network: "Private",
      saved: false,
    },
    modal: null,
  };
  const app = document.querySelector("#app");
  const overlays = document.querySelector("#overlay-root");
  let toastTimer;
  let returnFocus;
  function readStored(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }
  const storedDrafts = readStored("hivra-design-agent-drafts");
  for (const agent of agents) {
    if (typeof storedDrafts?.[agent.id] === "string")
      state.drafts[agent.id] = storedDrafts[agent.id];
  }
  const storedLaunch = readStored("hivra-design-launch-draft");
  if (storedLaunch && typeof storedLaunch === "object") {
    const choices = {
      type: ["agent", "computer"],
      location: ["Hivra Cloud (example)", "Existing host (example)"],
      runtime: ["Hermes", "Claude Code"],
      profile: ["Ubuntu desktop", "Ubuntu terminal"],
      size: ["Small · 2 vCPU / 4 GB", "Standard · 4 vCPU / 8 GB"],
      region: ["Automatic", "Europe", "United States"],
      network: ["Private", "Custom policy"],
    };
    for (const [field, values] of Object.entries(choices)) {
      if (values.includes(storedLaunch[field]))
        state.launch[field] = storedLaunch[field];
    }
    if (typeof storedLaunch.name === "string" && storedLaunch.name.trim()) {
      state.launch.name = storedLaunch.name.slice(0, 120);
      state.launch.autoName = storedLaunch.autoName === true;
    }
    if ([1, 2, 3].includes(storedLaunch.step))
      state.launch.step = storedLaunch.step;
  }
  try {
    const theme = localStorage.getItem("hivra-design-theme");
    if (["light", "dark"].includes(theme))
      document.documentElement.dataset.theme = theme;
  } catch {}
  function saveDrafts() {
    try {
      localStorage.setItem(
        "hivra-design-agent-drafts",
        JSON.stringify(state.drafts),
      );
      return true;
    } catch {
      return false;
    }
  }
  function saveLaunchDraft() {
    try {
      localStorage.setItem(
        "hivra-design-launch-draft",
        JSON.stringify(state.launch),
      );
      return true;
    } catch {
      return false;
    }
  }
  function toast(message) {
    const el = document.querySelector("#toast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 5200);
  }
  function button(label, action, extra = "", cls = "btn") {
    return `<button class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
  }
  function statusDot(item) {
    return `<span class="status-dot ${item.state === "blocked" ? "warn" : item.state === "stopped" || item.state === "native" ? "offline" : ""}" aria-hidden="true"></span>`;
  }
  function status(item) {
    return `<span class="status ${item.state === "blocked" ? "warn" : ""}">${statusDot(item)}${escape(item.status)}</span>`;
  }
  function navButton(view, label, i, count) {
    return `<button class="nav-item ${state.view === view ? "active" : ""}" data-nav="${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(i)}${label}${count !== undefined ? `<span class="nav-count">${count}</span>` : ""}</button>`;
  }
  function sidebar() {
    return `<div class="mobile-scrim ${state.mobile ? "open" : ""}" data-action="close-menu"></div><aside class="sidebar ${state.mobile ? "mobile-open" : ""}" aria-label="Workspace navigation">
    <div class="brand-row"><button class="brand" data-nav="home" aria-label="Hivra home"><span class="brand-mark">H.</span>HIVRA</button><button class="icon-button" data-action="workspace" aria-label="Switch workspace">${icon("ChevronDown")}</button></div>
    <button class="sidebar-search" data-action="switcher">${icon("Search")}Switch or search<kbd>⌘ K</kbd></button>
    <nav class="nav-list">${navButton("home", "Home", "House")}${navButton("agents", "All agents", "Bot", 3)}${navButton("computers", "All computers", "Monitor", computers.length)}${navButton("activity", "Activity", "Activity")}</nav>
    <div class="sidebar-resources"><div class="resource-group"><div class="group-heading">Recent agents<button data-nav="agents" aria-label="View all agents">${icon("ChevronRight")}</button></div>${agents.map((a) => `<button class="resource-link ${state.view === "agent" && state.id === a.id ? "active" : ""}" data-agent="${a.id}" ${state.view === "agent" && state.id === a.id ? 'aria-current="page"' : ""}><span class="tiny-avatar">${a.initial}</span>${a.name}${statusDot(a)}</button>`).join("")}</div>
    <div class="resource-group"><div class="group-heading">Recent computers<button data-nav="computers" aria-label="View all computers">${icon("ChevronRight")}</button></div>${computers
      .slice(0, 2)
      .map(
        (c) =>
          `<button class="resource-link ${state.view === "computer" && state.id === c.id ? "active" : ""}" data-computer="${c.id}" ${state.view === "computer" && state.id === c.id ? 'aria-current="page"' : ""}>${icon(c.type === "Desktop" ? "Monitor" : "Terminal")}${c.name}</button>`,
      )
      .join("")}</div></div>
    <div class="sidebar-footer">${[
      ["infrastructure", "Infrastructure", "Server"],
      ["settings", "Settings", "Settings"],
    ]
      .map(
        ([v, l, i]) =>
          `<button class="footer-link" data-nav="${v}">${icon(i)}${l}</button>`,
      )
      .join(
        "",
      )}<div class="account-row"><span class="user-avatar">A</span><span>Ash<small>Personal account</small></span><button class="icon-button" data-action="theme" aria-label="Switch to ${document.documentElement.dataset.theme === "dark" ? "light" : "dark"} theme">${icon(document.documentElement.dataset.theme === "dark" ? "Sun" : "Moon")}</button></div></div>
  </aside>`;
  }
  function selected() {
    return state.view === "agent"
      ? agents.find((a) => a.id === state.id)
      : state.view === "computer"
        ? computers.find((c) => c.id === state.id)
        : null;
  }
  function heading() {
    const titles = {
      home: "Home",
      agents: "All agents",
      computers: "All computers",
      activity: "Activity",
      settings: "Settings",
      infrastructure: "Infrastructure",
      applications: "Applications",
      help: "Help & shortcuts",
    };
    return selected()?.name || titles[state.view] || "Home";
  }
  function topbar() {
    return `<header class="topbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Open navigation" aria-expanded="${state.mobile}">${icon("Menu")}</button><div class="breadcrumb"><span class="workspace-crumb">Workspace</span>${icon("ChevronRight")}<strong>${escape(heading())}</strong></div><div class="topbar-actions"><button class="icon-button" data-action="switcher" aria-label="Search workspace">${icon("Search")}</button>${selected() ? button(`${icon("PanelRight")}<span>Details</span>`, "inspector", `id="details-toggle" aria-expanded="${state.inspector}"`) : ""}${button(`${icon("Plus")}New`, "launch", "", "btn primary")}</div></header>`;
  }
  function agentRow(a) {
    const c = computers.find((c) => c.id === a.computer);
    return `<button class="agent-row" data-agent="${a.id}" aria-label="Open ${a.name}, ${a.runtime}, ${a.status}"><span class="agent-name"><span class="avatar ${a.state === "native" ? "muted" : ""}">${a.initial}</span><span><strong>${a.name}</strong><small>${a.runtime} · ${a.role}</small></span></span><span class="computer-col muted">${c.name}</span>${status(a)}${icon("ChevronRight")}</button>`;
  }
  function listHeading() {
    return `<div class="list-heading" aria-hidden="true"><span>Agent</span><span class="computer-col">Computer</span><span>Status</span><span></span></div>`;
  }
  function computerCard(c) {
    return `<button class="computer-card" data-computer="${c.id}"><span class="computer-card-top">${icon(c.type === "Desktop" ? "Monitor" : "Terminal")}<span><strong>${c.name}</strong><p>${c.os}</p></span>${statusDot(c)}</span><span class="computer-card-bottom"><span class="linked">${icon("Bot")}${c.agents.length ? `${c.agents.length} linked agent${c.agents.length > 1 ? "s" : ""}` : "No agents"}</span><span>${c.state === "stopped" ? "Stopped" : `${c.cpu} · ${c.memory}`}</span></span></button>`;
  }
  function home() {
    const homeAgentRow = (a) => {
      const c = computers.find((c) => c.id === a.computer);
      return `<button class="home-resource-row" data-agent="${a.id}" aria-label="Open ${a.name}, ${a.runtime}, ${a.status}"><span class="avatar">${icon("Bot")}</span><span class="home-resource-copy"><strong>${a.name}</strong><small>${a.runtime} · ${c.name}</small></span>${status(a)}${icon("ArrowUpRight")}</button>`;
    };
    const homeComputerRow = (c) =>
      `<button class="home-resource-row" data-computer="${c.id}" aria-label="Open ${c.name}, ${c.os}, ${c.status}"><span class="avatar">${icon(c.type === "Desktop" ? "Monitor" : "Terminal")}</span><span class="home-resource-copy"><strong>${c.name}</strong><small>${c.os} · ${c.cpu} · ${c.memory}</small></span>${status(c)}${icon("ArrowUpRight")}</button>`;
    return `<div class="page home-page"><div class="page-heading home-intro"><p class="page-eyebrow">Hivra workspace</p><h1 class="welcome">Pick up your work.</h1><p>Open an agent or computer and continue where you left off.</p></div><div class="home-grid"><section class="home-panel" aria-labelledby="home-agents-heading"><div class="section-title"><div><p class="page-eyebrow">${icon("Bot")}Your agents</p><h2 id="home-agents-heading">Agents <span class="count">${agents.length}</span></h2></div><button class="text-link" data-nav="agents">View all ${icon("ArrowRight")}</button></div>${agents.map(homeAgentRow).join("")}</section><section class="home-panel" aria-labelledby="home-computers-heading"><div class="section-title"><div><p class="page-eyebrow">${icon("Monitor")}Your computers</p><h2 id="home-computers-heading">Computers <span class="count">${computers.length}</span></h2></div><button class="text-link" data-nav="computers">View all ${icon("ArrowRight")}</button></div>${computers.slice(0, 3).map(homeComputerRow).join("")}</section></div><div class="attention-row">${icon("CircleAlert")}<div><strong>Scout needs a chat update</strong><p>Its native interface is still available.</p></div>${button(`<span>Review</span>${icon("ArrowRight")}`, "review-scout", 'aria-label="Review Scout chat update"', "btn small")}</div><p class="workspace-note">${icon("Command")}Jump to any agent or computer with <kbd>⌘ K</kbd></p></div>`;
  }
  function inventory(kind) {
    const isAgents = kind === "agents";
    return `<div class="page"><div class="page-heading"><h1>${isAgents ? "Agents" : "Computers"}</h1><p>${isAgents ? "Your agents, with a clear path back to their work." : "The computers your agents and tools run on."}</p></div><div class="toolbar"><label class="input-search">${icon("Search")}<input id="inventory-search" type="search" placeholder="Find ${kind}…" aria-label="Search ${kind}" value="${escape(state.query)}"></label><div class="filter-group" aria-label="Filter ${kind}">${(isAgents
      ? [
          ["all", "All"],
          ["ready", "Available"],
          ["blocked", "Needs attention"],
        ]
      : [
          ["all", "All"],
          ["ready", "Available"],
          ["stopped", "Stopped"],
        ]
    )
      .map(
        ([id, label]) =>
          `<button class="filter-btn ${state.filter === id ? "active" : ""}" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`,
      )
      .join(
        "",
      )}</div></div><div id="inventory-results">${inventoryResults(kind)}</div></div>`;
  }
  function inventoryResults(kind) {
    const rows = (kind === "agents" ? agents : computers).filter(
      (a) =>
        (state.filter === "all" || a.state === state.filter) &&
        `${a.name} ${a.runtime || a.os} ${a.role || ""}`
          .toLowerCase()
          .includes(state.query.toLowerCase()),
    );
    return rows.length
      ? kind === "agents"
        ? `${listHeading()}${rows.map(agentRow).join("")}`
        : `<div class="computer-grid">${rows.map(computerCard).join("")}</div><p class="workspace-note">${icon("CircleHelp")}Select a computer to open its desktop or terminal and see linked agents.</p>`
      : `<div class="empty-list"><strong>No ${kind} found</strong><p>Try a different name or clear the filter.</p>${button("Clear search & filters", "clear-filters", "", "btn quiet")}</div>`;
  }
  function resourceTabs(isAgent) {
    const tabs = isAgent
      ? [
          ["conversation", "Conversation", "MessageSquare"],
          ["native", "Native interface", "ExternalLink"],
          ["manage", "Manage", "Settings"],
          ["files", "Files", "Folder"],
        ]
      : [
          [
            "workspace",
            selected().type === "Desktop" ? "Desktop" : "Terminal",
            selected().type === "Desktop" ? "Monitor" : "Terminal",
          ],
          ["linked", "Agents", "Bot"],
          ["manage", "Manage", "Settings"],
          ["files", "Files", "Folder"],
        ];
    return `<div class="resource-tabs" role="tablist" aria-label="${isAgent ? "Agent" : "Computer"} views">${tabs.map(([id, label, i]) => `<button class="resource-tab ${state.tab === id ? "active" : ""}" id="resource-tab-${id}" data-tab="${id}" role="tab" tabindex="${state.tab === id ? 0 : -1}" aria-selected="${state.tab === id}" aria-controls="resource-surface">${icon(i)}${label}</button>`).join("")}</div>`;
  }
  function agentDetail() {
    const a = selected();
    const c = computers.find((c) => c.id === a.computer);
    return `<div class="agent-detail"><div class="resource-header"><span class="avatar">${a.initial}</span><div class="resource-title"><h1>${a.name}</h1><p>${a.runtime}<span>·</span><button data-computer="${c.id}">${c.name}</button><span>·</span>${a.role}</p></div></div>${resourceTabs(true)}<div class="connection-line"><span class="status-dot"></span>Example agent · No live connection</div><div id="resource-surface" role="tabpanel" aria-labelledby="resource-tab-${state.tab}" tabindex="0" class="${state.tab === "conversation" && a.state === "ready" ? "agent-detail" : ""}" style="flex:1;min-height:0;overflow:auto">${state.tab === "conversation" ? (a.state === "ready" ? conversation(a) : unavailableConversation(a)) : state.tab === "native" ? nativeSurface(a) : state.tab === "manage" ? manageSurface(a, true) : filesSurface(a)}</div></div>`;
  }
  function conversation(a) {
    return `<div class="conversation"><div class="conversation-inner"><div class="conversation-symbol">${icon("MessageSquare")}</div><h2>What are we working on?</h2><p>${a.purpose}</p><div class="suggestions"><button class="suggestion" data-prompt="Help me research an idea and identify the questions worth exploring.">Think through an idea ${icon("ArrowUpRight")}</button><button class="suggestion" data-prompt="Help me turn my notes into a clear first draft.">Start a first draft ${icon("ArrowUpRight")}</button></div></div></div><div class="composer-wrap"><div class="composer"><textarea id="composer" aria-label="Message draft for ${a.name}" placeholder="Write to ${a.name}…">${escape(state.drafts[a.id] || "")}</textarea><div class="composer-footer"><span>${a.runtime}</span><span>·</span><span>Local draft</span>${button(`Save draft ${icon("ArrowUp")}`, "save-agent-draft", "", "btn small")}</div></div><p class="draft-note">Preview only. Save drafts in this browser; nothing is sent to an agent.</p></div>`;
  }
  function unavailableConversation(a) {
    return `<div class="surface-panel"><div class="blocked-callout"><h2>${icon(a.state === "blocked" ? "CircleAlert" : "ExternalLink")}${a.state === "blocked" ? "Chat needs an update" : "Use the native coding interface"}</h2><p>${a.state === "blocked" ? "This example shows an agent whose chat adapter needs an update. Its native interface is available as a separate entry point." : "This example agent works through its native interface. Hivra keeps the agent, computer, and access points together."}</p></div>${nativeEntry(a)}<p class="surface-caption">${icon("CircleHelp")}Status and access shown here are fictional preview states.</p></div>`;
  }
  function nativeEntry(a) {
    return `<div class="native-entry">${icon(a.runtime === "Claude Code" ? "Terminal" : "Globe")}<div><h3>${a.runtime === "Claude Code" ? "Claude Code terminal" : "Hermes dashboard"}</h3><p>The runtime’s own tools and conversation history.</p></div>${button(`Open ${icon("ArrowUpRight")}`, "preview-native", `data-name="${escape(a.name)}"`, "btn small")}</div>`;
  }
  const management = {
    runtime: {
      title: "Runtime & model",
      icon: "SlidersHorizontal",
      description: "Runtime-specific model selection and configuration.",
      effect:
        "Review supported model choices and runtime settings. Saving a real configuration would affect future agent work; supported options and credentials must be verified first.",
    },
    instructions: {
      title: "Instructions",
      icon: "MessageSquare",
      description: "The guidance this agent starts with.",
      effect:
        "Review persistent instructions for this agent. A real update would change the guidance used in future conversations and tasks.",
    },
    skills: {
      title: "Skills & tools",
      icon: "Folder",
      description: "Review the capabilities available to this agent.",
      effect:
        "Review installed skills and tool permissions for this agent. A real change could expand or restrict its capabilities and needs a runtime-specific review.",
    },
    channels: {
      title: "Channels",
      icon: "Globe",
      description: "Messaging connections supported by the runtime.",
      effect:
        "Review external messaging connections for this agent. A real channel connection could allow messages to reach it; identity, permissions, and runtime support must be checked first.",
    },
    power: {
      title: "Power",
      icon: "Pause",
      description: "Start, stop, or restart with a clear impact review.",
      effect:
        "Review start, stop, or restart controls for this computer. A real power change can interrupt connected sessions and agent work; the exact target and current state must be confirmed before execution.",
    },
    updates: {
      title: "Updates & maintenance",
      icon: "Activity",
      description: "Review supported updates before applying them.",
      effect:
        "Review available runtime and computer updates. A real update may require downtime or restart, so compatibility, data preservation, and recovery must be verified before applying it.",
    },
    resources: {
      title: "Resources",
      icon: "Cpu",
      description: "CPU, memory, and storage for this computer.",
      effect:
        "Review CPU, memory, and storage changes. A real resize may affect pricing and availability or require downtime; provider support and a current quote must be checked first.",
    },
    recovery: {
      title: "Recovery",
      icon: "ShieldCheck",
      description: "Connection recovery and available restore options.",
      effect:
        "Review supported recovery routes and available restore points for this computer. Restoring real data could replace current state; the target, preservation plan, and supported recovery method must be reviewed first.",
    },
    export: {
      title: "Export & move",
      icon: "Download",
      description: "Review what can be exported and where it can go.",
      effect:
        "Review export coverage for this computer and its linked agent. A real export may include private files, configuration, and secrets; the included data, destination, and provider capability must be checked before preparation.",
    },
  };
  function manageSurface(item, isAgent) {
    const groups = isAgent
      ? [
          ["Agent setup", ["runtime", "instructions"]],
          ["Capabilities & connections", ["skills", "channels"]],
        ]
      : [
          ["Power & maintenance", ["power", "updates"]],
          ["Computer configuration", ["resources"]],
          ["Data & recovery", ["recovery", "export"]],
        ];
    return `<div class="surface-panel manage-panel"><div class="page-heading"><h1>Manage ${item.name}</h1><p>Settings stay attached to this ${isAgent ? "agent" : "computer"}.</p></div><div class="manage-target">${icon(isAgent ? "Bot" : "Monitor")}<span>${item.name}</span><span class="muted">${isAgent ? item.runtime : item.os}</span><span class="draft-chip">Example resource</span></div>${groups
      .map(
        ([name, keys]) =>
          `<section class="manage-group"><h2>${name}</h2>${keys
            .map((key) => {
              const entry = management[key];
              return `<button class="manage-row" data-manage="${key}" aria-label="Review ${entry.title} for ${item.name}"><span class="manage-icon">${icon(entry.icon)}</span><span><strong>${entry.title}</strong><small>${entry.description}</small></span>${icon("ChevronRight")}</button>`;
            })
            .join("")}</section>`,
      )
      .join(
        "",
      )}<p class="surface-caption">${icon("CircleHelp")}Review previews only. No configuration or lifecycle changes are performed.</p></div>`;
  }
  function manageReview(key) {
    const item = selected(),
      entry = management[key];
    if (!item || !entry) return;
    openModal(
      `${modalHeader(`${escape(item.name)} · ${entry.title}`, "Review preview · No connected resource")}<div class="modal-body simple-modal"><div class="manage-review-target"><span>Selected ${state.view === "agent" ? "agent" : "computer"}</span><strong>${escape(item.name)}</strong></div><p>${entry.effect}</p><div class="info-note">No action has been performed. This preview does not change ${escape(item.name)}, prepare an export, or connect to a live resource.</div></div><div class="modal-footer"><span>Example data</span>${button("Close preview", "close-modal", "", "btn primary")}</div>`,
      "manage",
    );
  }
  function nativeSurface(a) {
    return `<div class="surface-panel"><div class="page-heading"><h1>Native interface</h1><p>Keep the full runtime available when you need it.</p></div>${nativeEntry(a)}<div class="native-entry">${icon("Monitor")}<div><h3>${computers.find((c) => c.id === a.computer).name}</h3><p>Open the computer behind this agent.</p></div><button class="btn small" data-computer="${a.computer}">View computer ${icon("ArrowRight")}</button></div><p class="surface-caption">${icon("CircleHelp")}This prototype does not connect to a running agent.</p></div>`;
  }
  function filesSurface(item) {
    return `<div class="surface-panel"><div class="surface-placeholder">${icon("Folder")}<h2>Files for ${item.name}</h2><p>In the product, this view uses the selected computer’s file access. The design preview has no connected filesystem.</p>${button("Preview file access", "preview-files")}</div></div>`;
  }
  function computerDetail() {
    const c = selected();
    return `<div class="agent-detail"><div class="resource-header"><span class="avatar muted">${icon(c.type === "Desktop" ? "Monitor" : "Terminal")}</span><div class="resource-title"><h1>${c.name}</h1><p>${c.os}<span>·</span>${status(c)}</p></div></div>${resourceTabs(false)}<div class="connection-line"><span class="status-dot"></span>Example computer · No live connection</div><div id="resource-surface" role="tabpanel" aria-labelledby="resource-tab-${state.tab}" tabindex="0" style="flex:1;overflow:auto">${
      state.tab === "linked"
        ? `<div class="surface-panel"><div class="section-title"><h2>Agents on this computer <span class="count">${c.agents.length}</span></h2></div>${c.agents.length ? c.agents.map((id) => agentRow(agents.find((a) => a.id === id))).join("") : `<div class="empty-list"><strong>No agents on this computer</strong><p>This example is a standalone computer.</p></div>`}</div>`
        : state.tab === "files"
          ? filesSurface(c)
          : state.tab === "manage"
            ? manageSurface(c, false)
            : `<div class="surface-panel">${c.state === "stopped" ? `<div class="blocked-callout"><h2>${icon("Pause")}This example computer is stopped</h2><p>Resource status belongs here. Starting, stopping, and deleting computers are excluded from this design preview.</p></div>` : ""}<div class="surface-placeholder">${icon(c.type === "Desktop" ? "Monitor" : "Terminal")}<h2>${c.type === "Desktop" ? "Your desktop opens here" : "Your terminal opens here"}</h2><p>${c.type === "Desktop" ? "A dedicated surface for this computer, with agent and file access one tab away." : "A dedicated terminal for this computer, with its agent always within reach."}</p>${button(`Preview ${c.type.toLowerCase()} access ${icon("ArrowUpRight")}`, "preview-computer", c.state === "stopped" ? "disabled" : "")}</div><p class="surface-caption">${icon("CircleHelp")}Layout placeholder. No desktop session or terminal output is being shown.</p><div class="section-title"><h2>On this computer</h2><button class="text-link" data-tab="linked">${c.agents.length} agent${c.agents.length !== 1 ? "s" : ""} ${icon("ArrowRight")}</button></div>${c.agents
                .slice(0, 1)
                .map((id) => agentRow(agents.find((a) => a.id === id)))
                .join(
                  "",
                )}${!c.agents.length ? '<p class="muted" style="font-size:12px">No agents linked in this example.</p>' : ""}</div>`
    }</div></div>`;
  }
  function inspector() {
    const item = selected();
    if (!state.inspector || !item) return "";
    const isAgent = state.view === "agent";
    const c = isAgent ? computers.find((c) => c.id === item.computer) : item;
    return `<aside class="inspector" aria-label="Details for ${item.name}"><div class="inspector-header"><span>${isAgent ? "Agent" : "Computer"} details</span><button class="icon-button" data-action="inspector" aria-label="Close details">${icon("X")}</button></div><span class="avatar">${isAgent ? item.initial : icon("Monitor")}</span><h2>${item.name}</h2><p>${isAgent ? item.role : item.os}</p><div class="detail-group"><h3>Overview</h3><dl class="details-list"><dt>Status</dt><dd>${status(item)}</dd>${isAgent ? `<dt>Runtime</dt><dd>${item.runtime}</dd>` : `<dt>Type</dt><dd>${item.type}</dd>`}<dt>Workspace</dt><dd>Personal</dd></dl></div>${isAgent ? `<div class="detail-group"><h3>Computer</h3><button class="detail-computer" data-computer="${c.id}">${icon("Monitor")}${c.name}${icon("ArrowRight")}</button></div>` : ""}<div class="detail-group"><h3>Computer resources</h3><dl class="details-list"><dt>CPU</dt><dd>${c.cpu}</dd><dt>Memory</dt><dd>${c.memory}</dd><dt>Storage</dt><dd>${c.storage}</dd></dl></div><details class="detail-disclosure"><summary>Advanced details</summary><p>Runtime versions, connection diagnostics, provider settings, and maintenance actions belong here. Values must come from the selected resource.</p>${button("Preview diagnostics", "preview-diagnostics", "", "btn small")}</details><p class="surface-caption">Example configuration.</p></aside>`;
  }
  function activity() {
    return `<div class="page"><div class="page-heading"><h1>Activity</h1><p>Changes and attention items across your workspace.</p></div><div class="info-note">Illustrative activity. These events did not happen in a live workspace.</div><div class="activity-list">${[
      {
        i: "CircleAlert",
        title: "Scout needs a chat update",
        body: "Native access remains available in this example.",
        time: "Example",
        agent: "scout",
      },
      {
        i: "MessageSquare",
        title: "Atlas conversation opened",
        body: "An example of a recent agent access event.",
        time: "Example",
        agent: "atlas",
      },
      {
        i: "Monitor",
        title: "Everyday Linux desktop opened",
        body: "An example of a recent computer access event.",
        time: "Example",
        computer: "everyday",
      },
    ]
      .map(
        (a) =>
          `<div class="activity-row"><span class="activity-icon">${icon(a.i)}</span><div><strong>${a.title}</strong><p>${a.body}</p><button class="text-link" ${a.agent ? `data-agent="${a.agent}"` : `data-computer="${a.computer}"`}>View ${a.agent ? "agent" : "computer"} ${icon("ArrowRight")}</button></div><time>${a.time}</time></div>`,
      )
      .join("")}</div></div>`;
  }
  function settings() {
    return `<div class="page"><div class="page-heading"><h1>Settings</h1><p>Workspace preferences, account, and billing in one place.</p></div><div class="settings-list"><section class="settings-section"><h2>Workspace</h2><div class="settings-row"><div><strong>Appearance</strong><p>Choose a comfortable theme for this workspace.</p></div>${button(document.documentElement.dataset.theme === "dark" ? "Light theme" : "Dark theme", "theme")}</div><div class="settings-row"><div><strong>Workspace name</strong><p>Ash’s workspace · Personal</p></div>${button("Edit", "preview-setting", 'data-label="Workspace name"')}</div></section><section class="settings-section"><h2>Account</h2>${[
      ["Account & security", "Manage your profile and sign-in settings."],
      ["Billing & usage", "Review charges and manage your plan."],
      ["Notifications", "Choose which workspace updates you receive."],
    ]
      .map(
        ([name, desc]) =>
          `<div class="settings-row"><div><strong>${name}</strong><p>${desc}</p></div>${button("Manage", "preview-setting", `data-label="${escape(name)}"`)}</div>`,
      )
      .join(
        "",
      )}</section><section class="settings-section"><h2>Workspace access & help</h2><div class="settings-row"><div><strong>Applications</strong><p>Open your workspace from a dedicated app or browser.</p></div><button class="btn" data-nav="applications">View apps</button></div><div class="settings-row"><div><strong>Help & shortcuts</strong><p>Navigation, keyboard shortcuts, and preview information.</p></div><button class="btn" data-nav="help">View help</button></div></section></div></div>`;
  }
  function infrastructure() {
    return `<div class="page"><div class="page-heading"><h1>Infrastructure</h1><p>Provider connections and operational details, when you need them.</p></div><div class="settings-list"><div class="info-note">Infrastructure is separate from everyday agent work. This preview contains no real provider connection.</div><section class="settings-section"><h2>Provider connections</h2><div class="settings-row"><div><strong>No provider connected in this preview</strong><p>Review a connection before adding self-hosted capacity.</p></div>${button("Preview setup", "preview-provider")}</div></section><section class="settings-section"><h2>Operations</h2>${[
      [
        "Connection diagnostics",
        "Inspect access and network health for a selected computer.",
      ],
      ["Runtime maintenance", "Review supported updates and their impact."],
      ["Access & networking", "Advanced connection policies live here."],
    ]
      .map(
        ([n, d]) =>
          `<div class="settings-row"><div><strong>${n}</strong><p>${d}</p></div>${button("Review", "preview-setting", `data-label="${n}"`)}</div>`,
      )
      .join("")}</section></div></div>`;
  }
  function applications() {
    return `<div class="page"><div class="page-heading"><h1>Applications</h1><p>Choose how you open your workspace.</p></div><div class="download-hero"><span class="brand-mark">H.</span><h2>Your workspace, within reach.</h2><p>The same agents and computers, with a familiar place to return to.</p></div><div class="platform-list"><div class="platform-row">${icon("Laptop")}<div><strong>Hivra for Mac</strong><p>A dedicated window for your workspace.</p></div>${button(`Review download ${icon("ArrowUpRight")}`, "preview-download", "", "btn small")}</div><div class="platform-row">${icon("Globe")}<div><strong>Web workspace</strong><p>Open Hivra in your browser.</p></div><span class="draft-chip" style="margin-left:auto">You’re here</span></div><div class="platform-row">${icon("Monitor")}<div><strong>Remote desktop access</strong><p>Connection options belong to each computer.</p></div><button class="btn small" data-nav="computers">View computers</button></div></div><p class="surface-caption">${icon("CircleHelp")}Download layout preview. Release availability is not checked here.</p></div>`;
  }
  function help() {
    return `<div class="page"><div class="page-heading"><h1>Help & shortcuts</h1><p>A few simple ways to get around.</p></div><div class="settings-list">${[
      [
        "Switch agents or computers",
        "Use search to jump directly to a resource.",
        "⌘ / Ctrl K",
      ],
      ["Dismiss a dialog", "Return to the work underneath.", "Esc"],
      ["Move through controls", "Every action is keyboard accessible.", "Tab"],
    ]
      .map(
        ([n, d, k]) =>
          `<div class="settings-row"><div><strong>${n}</strong><p>${d}</p></div><kbd style="margin-left:auto;white-space:nowrap">${k}</kbd></div>`,
      )
      .join(
        "",
      )}<div class="info-note">This is a local design preview. Resource names, statuses, and activity are example data. Conversation drafts and launch drafts are saved only in this browser.</div></div></div>`;
  }
  function content() {
    return (
      {
        home,
        agents: () => inventory("agents"),
        computers: () => inventory("computers"),
        agent: agentDetail,
        computer: computerDetail,
        activity,
        settings,
        infrastructure,
        applications,
        help,
      }[state.view] || home
    )();
  }
  function render() {
    app.innerHTML = `${sidebar()}<div class="main-shell">${topbar()}<div class="work-area"><main id="main" tabindex="-1">${content()}</main>${inspector()}</div></div>`;
    syncOverlayAccess();
  }
  function syncOverlayAccess() {
    const mobile = state.mobile && window.innerWidth <= 640;
    const details = state.inspector && window.innerWidth < 1200;
    document.querySelector(".main-shell").inert = mobile;
    document.querySelector(".sidebar").inert = details;
    document.querySelector("#main").inert = details;
    document.querySelector(".topbar").inert = details;
  }
  function navigate(view, id = null, fromHash = false) {
    state.view = view;
    state.id = id;
    state.tab =
      view === "computer"
        ? "workspace"
        : view === "agent" &&
            agents.find((a) => a.id === id)?.state === "native"
          ? "native"
          : "conversation";
    state.inspector = false;
    state.mobile = false;
    state.query = "";
    state.filter = "all";
    closeModal();
    if (!fromHash) {
      const hash = `#${view}${id ? `/${id}` : ""}`;
      if (location.hash !== hash) history.pushState(null, "", hash);
    }
    render();
  }
  function readRoute() {
    const [view, id] = location.hash.slice(1).split("/");
    if (view === "agent" && agents.some((a) => a.id === id))
      navigate(view, id, true);
    else if (view === "computer" && computers.some((c) => c.id === id))
      navigate(view, id, true);
    else if (
      [
        "home",
        "agents",
        "computers",
        "activity",
        "settings",
        "infrastructure",
        "applications",
        "help",
      ].includes(view)
    )
      navigate(view, null, true);
    else navigate("home", null, true);
  }
  function openModal(html, kind, cls = "") {
    returnFocus = document.activeElement;
    state.modal = kind;
    overlays.innerHTML = `<dialog class="${cls} ${kind === "launch" ? "launch-dialog" : ""}">${html}</dialog>`;
    const dialog = overlays.querySelector("dialog");
    dialog.setAttribute(
      "aria-label",
      dialog.querySelector("h2")?.textContent ||
        (kind === "switcher"
          ? "Switch agents, computers, or pages"
          : "Design preview"),
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeModal();
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        const box = dialog.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX > box.right ||
          e.clientY < box.top ||
          e.clientY > box.bottom
        )
          closeModal();
      }
    });
    dialog.showModal();
  }
  function closeModal() {
    const dialog = overlays.querySelector("dialog");
    if (dialog) {
      dialog.close();
      overlays.innerHTML = "";
      state.modal = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    }
  }
  function modalHeader(title, desc = "") {
    return `<div class="modal-header"><div><h2>${title}</h2>${desc ? `<p>${desc}</p>` : ""}</div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("X")}</button></div>`;
  }
  function info(title, body) {
    openModal(
      `${modalHeader(title)}<div class="modal-body simple-modal"><p>${body}</p></div><div class="modal-footer"><span>Design preview</span>${button("Got it", "close-modal", "", "btn primary")}</div>`,
      "info",
    );
  }
  function switcher() {
    openModal(
      `<div class="switcher-input">${icon("Search")}<input id="switcher-input" placeholder="Find an agent, computer, or page…" aria-label="Search workspace" autofocus><button class="icon-button" data-action="close-modal" aria-label="Close search">${icon("X")}</button></div><div class="switcher-results" id="switcher-results">${switcherResults("")}</div><div class="switcher-footer"><span><kbd>Tab</kbd> choose</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`,
      "switcher",
      "switcher-dialog",
    );
    document.querySelector("#switcher-input").focus();
  }
  function switcherResults(query) {
    const q = query.toLowerCase();
    const as = agents.filter((a) =>
      `${a.name} ${a.runtime} ${a.role}`.toLowerCase().includes(q),
    );
    const cs = computers.filter((c) =>
      `${c.name} ${c.os}`.toLowerCase().includes(q),
    );
    const pages = [
      ["home", "Home", "House"],
      ["agents", "All agents", "Bot"],
      ["computers", "All computers", "Monitor"],
      ["activity", "Activity", "Activity"],
      ["settings", "Settings", "Settings"],
      ["applications", "Applications", "Download"],
      ["infrastructure", "Infrastructure", "Server"],
      ["help", "Help & shortcuts", "CircleHelp"],
    ].filter((a) => a[1].toLowerCase().includes(q));
    return `${as.length ? `<div class="switcher-group">Agents</div>${as.map((a) => `<button class="switcher-result" data-agent="${a.id}"><span class="tiny-avatar">${a.initial}</span>${a.name}<small>${a.runtime}</small></button>`).join("")}` : ""}${cs.length ? `<div class="switcher-group">Computers</div>${cs.map((c) => `<button class="switcher-result" data-computer="${c.id}">${icon("Monitor")}${c.name}<small>${c.os}</small></button>`).join("")}` : ""}${pages.length ? `<div class="switcher-group">Pages</div>${pages.map(([v, n, i]) => `<button class="switcher-result" data-nav="${v}">${icon(i)}${n}</button>`).join("")}` : ""}${!as.length && !cs.length && !pages.length ? '<div class="empty-list"><strong>No matches</strong><p>Try an agent name, computer, or page.</p></div>' : ""}`;
  }
  function launch() {
    state.launch.saved = false;
    renderLaunch();
  }
  function renderLaunch() {
    const l = state.launch;
    const steps = `<div class="stepper" aria-label="Step ${l.step} of 3">${["Choose", "Configure", "Review"].map((s, i) => `${i ? "<i></i>" : ""}<span class="${l.step === i + 1 ? "current" : ""}"><b>${l.step > i + 1 ? icon("Check") : i + 1}</b>${s}</span>`).join("")}</div>`;
    let body = "";
    if (l.saved) {
      body = `<div class="draft-success">${icon("Check")}<h2>Launch draft saved</h2><p>Your configuration is saved in this browser. No computer or agent was created, and no charge was made.</p><span class="draft-chip">${escape(l.name || (l.type === "agent" ? "New agent" : "New computer"))}</span></div>`;
    } else if (l.step === 1) {
      body = `${steps}<h3 class="launch-question">What would you like to create?</h3><p class="launch-description">Choose the starting point. You’ll review the setup before launch.</p><div class="choice-list">${[
        ["agent", "Bot", "An agent", "A ready-to-use agent on a new computer."],
        [
          "computer",
          "Monitor",
          "A computer",
          "A desktop or terminal, with no agent attached.",
        ],
      ]
        .map(
          ([id, i, n, d]) =>
            `<button class="choice ${l.type === id ? "selected" : ""}" data-launch-type="${id}" aria-pressed="${l.type === id}">${icon(i)}<span><strong>${n}</strong><p>${d}</p></span><span class="selection-dot">${l.type === id ? icon("Check") : ""}</span></button>`,
        )
        .join(
          "",
        )}</div><p class="review-note">This flow allocates a new computer. It does not add an agent to an existing computer.</p>`;
    } else if (l.step === 2) {
      body = `${steps}<h3 class="launch-question">Make it yours.</h3><p class="launch-description">A few essentials first. Advanced settings stay within reach.</p><div class="launch-location"><span>Runs on: <strong>${escape(l.location)}</strong></span><button class="text-link" data-action="launch-location" aria-expanded="${l.showLocation}">${l.showLocation ? "Done" : "Change"}</button></div>${l.showLocation ? `<label class="field"><span>Where to create the new computer</span><select data-launch-field="location"><option ${l.location === "Hivra Cloud (example)" ? "selected" : ""}>Hivra Cloud (example)</option><option ${l.location === "Existing host (example)" ? "selected" : ""}>Existing host (example)</option></select><small>Example destinations. Existing capacity still creates a new isolated computer; it does not attach to an existing computer.</small></label>` : ""}<label class="field"><span>${l.type === "agent" ? "Agent" : "Computer"} name</span><input id="launch-name" data-launch-field="name" value="${escape(l.name)}" maxlength="60" placeholder="${l.type === "agent" ? "e.g. Research assistant" : "e.g. Personal computer"}" autocomplete="off"><small>A name you can recognize in your workspace.</small></label>${l.type === "agent" ? `<label class="field"><span>Agent runtime</span><select data-launch-field="runtime"><option ${l.runtime === "Hermes" ? "selected" : ""}>Hermes</option><option ${l.runtime === "Claude Code" ? "selected" : ""}>Claude Code</option></select><small>Examples for this design study. Live availability must be checked.</small></label>` : ""}<div class="field-pair"><label class="field"><span>New computer</span><select data-launch-field="profile"><option ${l.profile === "Ubuntu desktop" ? "selected" : ""}>Ubuntu desktop</option><option ${l.profile === "Ubuntu terminal" ? "selected" : ""}>Ubuntu terminal</option></select></label><label class="field"><span>Resources</span><select data-launch-field="size"><option ${l.size === "Standard · 4 vCPU / 8 GB" ? "selected" : ""}>Standard · 4 vCPU / 8 GB</option><option ${l.size === "Small · 2 vCPU / 4 GB" ? "selected" : ""}>Small · 2 vCPU / 4 GB</option></select></label></div><details class="advanced"><summary>Advanced settings</summary><label class="field"><span>Region preference</span><select data-launch-field="region"><option ${l.region === "Automatic" ? "selected" : ""}>Automatic</option><option ${l.region === "Europe" ? "selected" : ""}>Europe</option><option ${l.region === "United States" ? "selected" : ""}>United States</option></select><small>Illustrative choices. A live provider determines available locations.</small></label><label class="field"><span>Network access</span><select data-launch-field="network"><option ${l.network === "Private" ? "selected" : ""}>Private</option><option ${l.network === "Custom policy" ? "selected" : ""}>Custom policy</option></select><small>A custom policy requires a separate review in the product.</small></label></details>`;
    } else {
      body = `${steps}<h3 class="launch-question">Review your setup.</h3><p class="launch-description">Everything in one place before the final step.</p><div class="review-summary"><h3>${icon(l.type === "agent" ? "Bot" : "Monitor")}${escape(l.name || (l.type === "agent" ? "New agent" : "New computer"))}</h3><dl class="details-list"><dt>Creates</dt><dd>${l.type === "agent" ? "1 agent + 1 new computer" : "1 new computer"}</dd>${l.type === "agent" ? `<dt>Runtime</dt><dd>${l.runtime}</dd>` : ""}<dt>Runs on</dt><dd>${escape(l.location)}</dd><dt>Computer</dt><dd>${l.profile}</dd><dt>Isolation</dt><dd>Dedicated computer (example)</dd><dt>Data location</dt><dd>${l.location === "Hivra Cloud (example)" ? "New computer disk · Region to verify" : "Selected host disk · Location to verify"}</dd><dt>Resources</dt><dd>${l.size}</dd><dt>Region preference</dt><dd>${l.region}</dd><dt>Network</dt><dd>${l.network}</dd><dt>Price</dt><dd>Live quote required</dd></dl></div><p class="review-note">This preview saves a local draft only. In the product, availability, connection requirements, and the full price must be confirmed before creating a resource.</p>`;
    }
    const footer = l.saved
      ? `${button("Close", "close-modal")}<span>Saved locally</span>`
      : `${l.step === 1 ? "<span>Preview · No charges</span>" : button(`${icon("ArrowLeft")}Back`, "launch-back")}${button(l.step === 3 ? "Save launch draft" : `Continue ${icon("ArrowRight")}`, "launch-next", "", "btn primary")}`;
    const previous = returnFocus;
    const existing = overlays.querySelector("dialog");
    if (existing) {
      existing.close();
      overlays.innerHTML = "";
    }
    openModal(
      `${modalHeader(l.saved ? "New resource" : "New resource", "Configure first. Review before anything is created.")}<div class="modal-body">${body}</div><div class="modal-footer">${footer}</div>`,
      "launch",
    );
    if (existing && previous?.isConnected) returnFocus = previous;
    const heading = overlays.querySelector(".launch-question");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest(".skip-link")) {
      event.preventDefault();
      document.querySelector("#main")?.focus();
      return;
    }
    const target = event.target.closest("button,[data-action]");
    if (!target) return;
    const d = target.dataset;
    if (d.nav) {
      navigate(d.nav);
      return;
    }
    if (d.agent) {
      navigate("agent", d.agent);
      return;
    }
    if (d.computer) {
      navigate("computer", d.computer);
      return;
    }
    if (d.tab) {
      state.tab = d.tab;
      render();
      document.querySelector(`#resource-tab-${state.tab}`)?.focus();
      return;
    }
    if (d.filter) {
      state.filter = d.filter;
      render();
      return;
    }
    if (d.prompt) {
      state.drafts[state.id] = d.prompt;
      saveDrafts();
      render();
      document.querySelector("#composer")?.focus();
      return;
    }
    if (d.launchType) {
      state.launch.type = d.launchType;
      if (state.launch.autoName)
        state.launch.name =
          d.launchType === "agent" ? "Research agent" : "Ubuntu computer";
      saveLaunchDraft();
      renderLaunch();
      return;
    }
    if (d.manage) {
      manageReview(d.manage);
      return;
    }
    switch (d.action) {
      case "menu":
        state.mobile = !state.mobile;
        render();
        document
          .querySelector(state.mobile ? ".sidebar .brand" : ".mobile-menu")
          ?.focus();
        break;
      case "close-menu":
        state.mobile = false;
        render();
        document.querySelector(".mobile-menu")?.focus();
        break;
      case "switcher":
        switcher();
        break;
      case "close-modal":
        closeModal();
        break;
      case "workspace":
        info(
          "Personal workspace",
          "This preview shows one personal workspace. Workspace switching would list only workspaces you can access.",
        );
        break;
      case "theme":
        document.documentElement.dataset.theme =
          document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        try {
          localStorage.setItem(
            "hivra-design-theme",
            document.documentElement.dataset.theme,
          );
        } catch {}
        render();
        break;
      case "inspector":
        state.inspector = !state.inspector;
        render();
        document
          .querySelector(
            state.inspector ? ".inspector .icon-button" : "#details-toggle",
          )
          ?.focus();
        break;
      case "review-scout":
        navigate("agent", "scout");
        break;
      case "clear-filters":
        state.query = "";
        state.filter = "all";
        render();
        break;
      case "save-agent-draft":
        toast(
          state.drafts[state.id]?.trim()
            ? saveDrafts()
              ? `Draft for ${selected().name} saved in this browser. Nothing was sent.`
              : "Browser storage is unavailable. Your draft is kept in this tab only; copy it before closing."
            : "Write a message to save a local draft.",
        );
        break;
      case "launch":
        launch();
        break;
      case "launch-location":
        state.launch.showLocation = !state.launch.showLocation;
        renderLaunch();
        break;
      case "launch-back":
        state.launch.step = Math.max(1, state.launch.step - 1);
        saveLaunchDraft();
        renderLaunch();
        break;
      case "launch-next":
        if (state.launch.step < 3) {
          if (state.launch.step === 2 && !state.launch.name.trim())
            state.launch.name =
              state.launch.type === "agent"
                ? "Research agent"
                : "Ubuntu computer";
          state.launch.step++;
          saveLaunchDraft();
        } else {
          state.launch.saved = saveLaunchDraft();
          if (!state.launch.saved)
            toast(
              "Browser storage is unavailable. This launch draft is kept in this tab only; it was not saved.",
            );
        }
        renderLaunch();
        break;
      case "preview-native":
        info(
          "Open native interface",
          `In the product, this opens the verified native access route for ${escape(d.name || selected()?.name || "this agent")}. This preview has no connected runtime and does not open an external session.`,
        );
        break;
      case "preview-computer":
        info(
          "Open computer",
          "The selected computer’s verified desktop or terminal connection opens here. This preview does not connect to a computer.",
        );
        break;
      case "preview-files":
        info(
          "Files",
          "File access stays scoped to the selected resource. This preview does not read or change any files.",
        );
        break;
      case "preview-diagnostics":
        info(
          "Connection diagnostics",
          "The product should show actual access checks, runtime versions, and relevant errors for this selected resource. No diagnostics have run in this preview.",
        );
        break;
      case "preview-download":
        info(
          "Review Mac download",
          "The product should show the verified current release, system requirements, and download destination here. No application has been downloaded or installed.",
        );
        break;
      case "preview-provider":
        info(
          "Provider setup",
          "A provider connection needs its own capability and access review. This prototype does not collect credentials or add capacity.",
        );
        break;
      case "preview-setting":
        info(
          escape(d.label),
          "This is the proposed location for these settings. No account, billing, provider, or resource settings are changed by this preview.",
        );
        break;
    }
  });
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.id === "inventory-search") {
      state.query = el.value;
      document.querySelector("#inventory-results").innerHTML = inventoryResults(
        state.view,
      );
    }
    if (el.id === "switcher-input")
      document.querySelector("#switcher-results").innerHTML = switcherResults(
        el.value,
      );
    if (el.id === "composer") {
      state.drafts[state.id] = el.value;
      saveDrafts();
    }
    if (el.dataset.launchField) {
      state.launch[el.dataset.launchField] = el.value;
      if (el.dataset.launchField === "name") state.launch.autoName = false;
      el.setCustomValidity?.("");
      saveLaunchDraft();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.dataset.launchField) {
      state.launch[event.target.dataset.launchField] = event.target.value;
      saveLaunchDraft();
    }
    if (event.target.dataset.launchField === "location")
      document.querySelector(".launch-location strong").textContent =
        event.target.value;
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.target.matches('[role="tab"]') &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      const tabs = [
        ...event.target.parentElement.querySelectorAll('[role="tab"]'),
      ];
      const current = tabs.indexOf(event.target);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      event.preventDefault();
      tabs[next].click();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (state.modal === "switcher") closeModal();
      else switcher();
    }
    if (event.key === "Escape" && !state.modal) {
      if (state.inspector) {
        state.inspector = false;
        render();
        document.querySelector("#details-toggle")?.focus();
      } else if (state.mobile) {
        state.mobile = false;
        render();
        document.querySelector(".mobile-menu")?.focus();
      }
    }
    if (
      state.modal === "switcher" &&
      event.key === "Enter" &&
      event.target.id === "switcher-input"
    ) {
      event.preventDefault();
      document.querySelector(".switcher-result")?.click();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || state.modal) return;
    const scope =
      state.mobile && window.innerWidth <= 640
        ? document.querySelector(".sidebar")
        : state.inspector && window.innerWidth < 1200
          ? document.querySelector(".inspector")
          : null;
    if (!scope) return;
    const focusable = [
      ...scope.querySelectorAll(
        'button:not([disabled]),input,select,textarea,a,summary,[tabindex=\"0\"]',
      ),
    ].filter((el) => el.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("resize", syncOverlayAccess);
  window.addEventListener("popstate", readRoute);
  window.addEventListener("hashchange", readRoute);
  readRoute();
})();
