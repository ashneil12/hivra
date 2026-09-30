(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const query = (selector, scope = document) => scope.querySelector(selector);
  const all = (selector, scope = document) => [
    ...scope.querySelectorAll(selector),
  ];
  const preference = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* Controls also work without storage. */
      }
    },
  };
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const preferredTheme = matchMedia("(prefers-color-scheme: light)");
  const listenMedia = (media, callback) => {
    if (media.addEventListener) media.addEventListener("change", callback);
    else media.addListener(callback);
  };

  let motionPreference = preference.get("hivra-litepaper-motion");
  let themePreference = preference.get("hivra-litepaper-theme");
  let reading = false;
  let expandedProducts = false;
  let activeProduct = "gate";
  let activeStage = "all";
  let motionContext = null;
  let motionMedia = null;
  let progressTrigger = null;
  let refreshFrame = 0;
  let productFocusRequest = 0;
  let motionAvailable = Boolean(window.gsap && window.ScrollTrigger);
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;

  const motionAllowed = () =>
    !reading &&
    motionPreference !== "off" &&
    (motionPreference === "on" || !reducedMotion.matches);
  const shouldAnimate = () => motionAvailable && motionAllowed();
  const interactionAnimations = new Set();
  function revealInteraction(element, distance = 22, duration = 650) {
    if (!element || !shouldAnimate() || !element.animate) return;
    element.getAnimations().forEach((animation) => animation.cancel());
    const animation = element.animate(
      [
        { opacity: 0.3, transform: `translateY(${distance}px)` },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    interactionAnimations.add(animation);
    animation.finished.then(
      () => interactionAnimations.delete(animation),
      () => interactionAnimations.delete(animation),
    );
  }
  const touchPointer = matchMedia("(pointer: coarse)");
  function setInputVerb(touch) {
    all("[data-input-verb]").forEach((label) => {
      label.textContent = touch ? "Tap" : "Click";
    });
  }
  setInputVerb(touchPointer.matches);
  listenMedia(touchPointer, () => setInputVerb(touchPointer.matches));
  document.addEventListener(
    "pointerdown",
    (event) => setInputVerb(event.pointerType === "touch"),
    { passive: true },
  );

  // Wrap each word in a mask so a scene can raise it into place. The words
  // read and look exactly the same when nothing animates.
  function splitWords(element) {
    if (!element || element.classList.contains("split-words")) return;
    element.classList.add("split-words");
    [...element.childNodes].forEach((node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const fragment = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          fragment.append(part);
          return;
        }
        const word = document.createElement("span");
        const inner = document.createElement("span");
        word.className = "w";
        inner.className = "wi";
        inner.textContent = part;
        word.append(inner);
        fragment.append(word);
      });
      node.replaceWith(fragment);
    });
  }
  all(".passage-room, .passage-decide").forEach(splitWords);

  function refreshLayout() {
    if (!motionAvailable || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      ScrollTrigger.refresh();
    });
  }

  function afterLayout(callback) {
    requestAnimationFrame(() => {
      // ScrollTrigger refresh restores its captured scroll position. Complete it before
      // deliberate navigation, then measure the final pinned/static layout next frame.
      cancelAnimationFrame(refreshFrame);
      refreshFrame = 0;
      if (motionAvailable) ScrollTrigger.refresh();
      requestAnimationFrame(callback);
    });
  }

  function scrollToPosition(top) {
    const priorBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(window.scrollX, top);
    root.style.scrollBehavior = priorBehavior;
    if (motionAvailable) ScrollTrigger.update();
  }

  function applyTheme() {
    const theme =
      themePreference === "light" || themePreference === "dark"
        ? themePreference
        : preferredTheme.matches
          ? "light"
          : "dark";
    root.dataset.theme = theme;
    all(".theme-toggle").forEach((button) => {
      button.textContent = theme === "light" ? "Dark" : "Light";
      button.setAttribute(
        "aria-label",
        `Switch to ${theme === "light" ? "dark" : "light"} theme`,
      );
    });
    const themeColor = query('meta[name="theme-color"]');
    if (themeColor)
      themeColor.content = theme === "light" ? "#f2f0eb" : "#090909";
  }

  all(".theme-toggle").forEach((button) =>
    button.addEventListener("click", () => {
      themePreference = root.dataset.theme === "light" ? "dark" : "light";
      preference.set("hivra-litepaper-theme", themePreference);
      applyTheme();
    }),
  );
  listenMedia(preferredTheme, () => {
    if (!themePreference) applyTheme();
  });
  applyTheme();

  const roadmap = query(".roadmap");
  const panels = all(".product-panel");
  const panelByProduct = new Map(
    panels.map((panel) => [panel.id.replace(/^product-/, ""), panel]),
  );
  const productControls = all("[data-product]");
  const productNodes = all(".atlas-node");
  // Keep the index's navigation and entry motion aligned with its CSS layout.
  const atlasIndexQuery = "(max-width: 1279px)";
  const atlasIndex = matchMedia(atlasIndexQuery);
  const showAllProducts = () => reading || expandedProducts;

  function renderProducts() {
    const expanded = showAllProducts();
    const selected = panelByProduct.get(activeProduct);
    const related = new Set(
      selected
        ? all(".related [data-product]", selected).map(
            (button) => button.dataset.product,
          )
        : [],
    );
    if (roadmap) {
      roadmap.classList.toggle("all-products", expanded);
      roadmap.dataset.activeProduct = activeProduct;
      roadmap.dataset.stageFilter = activeStage;
    }
    panels.forEach((panel) => {
      const selectedPanel = panel === selected;
      panel.hidden = !expanded && !selectedPanel;
      panel.classList.toggle("is-active", selectedPanel);
    });
    productControls.forEach((button) => {
      const panel = panelByProduct.get(button.dataset.product);
      if (!panel) return;
      button.setAttribute("aria-controls", panel.id);
      button.setAttribute("aria-expanded", String(!panel.hidden));
    });
    productNodes.forEach((node) => {
      const product = node.dataset.product;
      const stage = panelByProduct.get(product)?.dataset.stage;
      node.dataset.stage = stage || "";
      node.classList.toggle("is-active", product === activeProduct);
      node.setAttribute("aria-pressed", String(product === activeProduct));
      node.classList.toggle("is-related", related.has(product));
      node.classList.toggle(
        "is-dimmed",
        activeStage !== "all" && stage !== activeStage,
      );
    });
    all("[data-line]").forEach((line) => {
      line.classList.toggle("is-active", line.dataset.line === activeProduct);
      line.classList.toggle("is-related", related.has(line.dataset.line));
    });
    all("button[data-stage-filter]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stageFilter === activeStage),
      );
    });
    all(".expand-products").forEach((button) => {
      button.setAttribute("aria-pressed", String(expanded));
      button.disabled = reading;
      button.textContent = reading
        ? "All 15 in reading mode"
        : expanded
          ? "Return to the atlas"
          : "Read all 15";
    });
    refreshLayout();
  }

  function focusProduct(panel, scroll = true) {
    const request = ++productFocusRequest;
    afterLayout(() => {
      if (request !== productFocusRequest || panel.hidden) return;
      panel.focus({ preventScroll: true });
      if (scroll) {
        const declaredMargin =
          parseFloat(getComputedStyle(panel).scrollMarginTop) || 0;
        const headerBottom =
          query(".site-header")?.getBoundingClientRect().bottom || 0;
        const margin = Math.max(declaredMargin, headerBottom + 18);
        scrollToPosition(
          window.scrollY + panel.getBoundingClientRect().top - margin,
        );
        updateChapter();
      }
      // Start only after the final scroll position is applied so the transition
      // is visible on phones, rather than completing above the viewport.
      requestAnimationFrame(() => {
        if (request === productFocusRequest && !panel.hidden)
          revealInteraction(panel);
      });
    });
  }

  function selectProduct(product, { focus = false, scroll = false } = {}) {
    const panel = panelByProduct.get(product);
    if (!panel) return;
    activeProduct = product;
    // Selecting a dimmed node remains possible; restore the full map to show its context.
    if (activeStage !== "all" && panel.dataset.stage !== activeStage)
      activeStage = "all";
    renderProducts();
    if (focus) focusProduct(panel, scroll);
    else
      afterLayout(() => {
        if (!panel.hidden && product === activeProduct)
          revealInteraction(panel);
      });
  }

  productControls.forEach((button) =>
    button.addEventListener("click", (event) => {
      const withinPanel = Boolean(button.closest(".product-panel"));
      const indexLayout = atlasIndex.matches;
      selectProduct(button.dataset.product, {
        focus:
          withinPanel || showAllProducts() || indexLayout || event.detail === 0,
        scroll:
          withinPanel || showAllProducts() || indexLayout || event.detail === 0,
      });
    }),
  );

  all("button[data-stage-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      activeStage = button.dataset.stageFilter;
      const first = panels.find((panel) => panel.dataset.stage === activeStage);
      if (first) activeProduct = first.id.replace(/^product-/, "");
      renderProducts();
      const selected = panelByProduct.get(activeProduct);
      afterLayout(() => {
        if (selected && selected.getBoundingClientRect().top < innerHeight)
          revealInteraction(selected);
      });
    }),
  );

  all(".expand-products").forEach((button) =>
    button.addEventListener("click", () => {
      expandedProducts = !expandedProducts;
      renderProducts();
    }),
  );

  function showProductFromHash() {
    const product = location.hash.replace(/^#product-/, "");
    if (!location.hash.startsWith("#product-") || !panelByProduct.has(product))
      return;
    selectProduct(product);
    focusProduct(panelByProduct.get(product));
  }
  window.addEventListener("hashchange", showProductFromHash);
  all(".back-to-atlas").forEach((button) =>
    button.addEventListener("click", () => {
      expandedProducts = false;
      renderProducts();
      afterLayout(() => {
        const map = query(".atlas-map");
        const selectedNode = productNodes.find(
          (node) => node.dataset.product === activeProduct,
        );
        if (!map || !selectedNode) return;
        selectedNode.focus({ preventScroll: true });
        scrollToPosition(
          window.scrollY + map.getBoundingClientRect().top - 100,
        );
        updateChapter();
      });
    }),
  );

  // The boundary lab: the three setups from the "Try it" copy. Lines show what
  // sits within the agent's reach and stop where a boundary cuts them off.
  const lab = query(".boundary-lab");
  if (lab) {
    const svg = query(".reach-map", lab);
    const agent = query(".agent-core", lab);
    const gate = query(".boundary-gate", lab);
    const items = all(".lab-item", lab);
    const readout = query(".lab-readout", lab);
    const NS = "http://www.w3.org/2000/svg";
    const lines = items.map(() => {
      const line = document.createElementNS(NS, "path");
      const cut = document.createElementNS(NS, "path");
      cut.setAttribute("class", "cut");
      svg.append(line, cut);
      return { line, cut };
    });
    const statusFor = (mode, resource) =>
      mode === "shared"
        ? "Beside the agent"
        : mode === "project" && resource === "project"
          ? "Shared with the agent"
          : "Outside its computer";
    let followUntil = 0;
    let followFrame = 0;
    let demo = [];
    const centre = (element, box) => {
      const rect = element.getBoundingClientRect();
      return [
        rect.left + rect.width / 2 - box.left,
        rect.top + rect.height / 2 - box.top,
      ];
    };
    function drawReach() {
      const box = lab.getBoundingClientRect();
      if (!box.width) return;
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
      const [ax, ay] = centre(agent, box);
      const gateX = gate.getBoundingClientRect().left - box.left + 7;
      const mode = lab.dataset.mode;
      items.forEach((item, index) => {
        const [x, y] = centre(item, box);
        const { line, cut } = lines[index];
        const open =
          mode === "shared" ||
          (mode === "project" && item.dataset.resource === "project");
        if (open || ax <= gateX || x >= gateX) {
          line.setAttribute("class", open ? "reach" : "blocked is-hidden");
          line.setAttribute("d", `M${ax} ${ay}L${x} ${y}`);
          cut.classList.add("is-hidden");
          return;
        }
        // The line runs from the agent to the boundary and stops there.
        const cy = ay + ((y - ay) * (ax - gateX)) / (ax - x);
        line.setAttribute("class", "blocked");
        line.setAttribute("d", `M${ax} ${ay}L${gateX} ${cy}`);
        cut.setAttribute("d", `M${gateX} ${cy - 6}L${gateX} ${cy + 6}`);
        cut.classList.remove("is-hidden");
      });
    }
    function followReach(duration = 1000) {
      followUntil = performance.now() + duration;
      if (followFrame) return;
      const step = (now) => {
        drawReach();
        followFrame = now < followUntil ? requestAnimationFrame(step) : 0;
      };
      followFrame = requestAnimationFrame(step);
    }
    function setLabMode(mode) {
      lab.dataset.mode = mode;
      all("[data-boundary]").forEach((control) =>
        control.setAttribute(
          "aria-pressed",
          String(control.dataset.boundary === mode),
        ),
      );
      items.forEach((item) => {
        item.dataset.status = statusFor(mode, item.dataset.resource);
      });
      const selected = items.find(
        (item) => item.getAttribute("aria-pressed") === "true",
      );
      if (selected)
        readout.textContent = `${selected.textContent}: ${selected.dataset.status}.`;
      followReach();
    }
    function stopDemo() {
      demo.forEach(clearTimeout);
      demo = [];
    }
    all("[data-boundary]").forEach((button) =>
      button.addEventListener("click", () => {
        stopDemo();
        setLabMode(button.dataset.boundary);
      }),
    );
    items.forEach((item) =>
      item.addEventListener("click", () => {
        stopDemo();
        const pressed = item.getAttribute("aria-pressed") !== "true";
        items.forEach((other) =>
          other.setAttribute("aria-pressed", String(pressed && other === item)),
        );
        readout.textContent = pressed
          ? `${item.textContent}: ${item.dataset.status}.`
          : "";
      }),
    );
    setLabMode(lab.dataset.mode || "shared");
    if ("ResizeObserver" in window) new ResizeObserver(() => drawReach()).observe(lab);
    if (document.fonts?.ready) document.fonts.ready.then(drawReach);
    // Once, when a reader first reaches it with motion on, the lab walks
    // through its three setups. Any touch of the controls takes over.
    if ("IntersectionObserver" in window) {
      const firstView = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          firstView.disconnect();
          if (!shouldAnimate()) return;
          demo = [
            setTimeout(() => setLabMode("separate"), 1500),
            setTimeout(() => setLabMode("project"), 3500),
          ];
        },
        { threshold: 0.6 },
      );
      firstView.observe(lab);
    }
  }

  // Where it fits: one red frame around Hivra's column, measured from the
  // table so it follows the layout at every width.
  const fitTable = query(".fit-table");
  let fitFrame = null;
  function placeFitFrame() {
    const head = fitTable && query("thead th.is-hivra", fitTable);
    const cells = fitTable ? all("td.is-hivra", fitTable) : [];
    if (!head || !cells.length) return;
    if (!fitFrame) {
      fitFrame = document.createElement("div");
      fitFrame.className = "fit-frame";
      fitFrame.setAttribute("aria-hidden", "true");
      fitTable.append(fitFrame);
    }
    const base = fitTable.getBoundingClientRect();
    const top = head.getBoundingClientRect();
    const bottom = cells[cells.length - 1].getBoundingClientRect();
    fitFrame.style.left = `${top.left - base.left + fitTable.scrollLeft}px`;
    fitFrame.style.top = `${top.top - base.top}px`;
    fitFrame.style.width = `${top.width}px`;
    fitFrame.style.height = `${bottom.bottom - top.top}px`;
  }
  if (fitTable) {
    placeFitFrame();
    if ("ResizeObserver" in window)
      new ResizeObserver(placeFitFrame).observe(fitTable);
    if (document.fonts?.ready) document.fonts.ready.then(placeFitFrame);
  }

  // The canvas is a decorative layer. It owns one cancellable, 30 fps loop only while visible.
  const particles = (() => {
    const canvas = query("#field-canvas");
    if (!canvas) return { sync() {} };
    const context = canvas.getContext("2d");
    if (!context) return { sync() {} };
    let visible = false;
    let frame = 0;
    let lastDraw = 0;
    let width = 1;
    let height = 1;
    const motes = Array.from({ length: 36 }, () => ({
      x: 0.36 + Math.random() * 0.64,
      y: Math.random(),
      phase: Math.random() * Math.PI * 2,
      speed: 0.18 + Math.random() * 0.24,
      size: 0.4 + Math.random() * 1.15,
      alpha: 0.12 + Math.random() * 0.25,
    }));

    function resize() {
      width = Math.max(1, canvas.clientWidth);
      height = Math.max(1, canvas.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function draw(now) {
      frame = 0;
      if (!visible || document.hidden || !shouldAnimate()) return;
      if (now - lastDraw >= 1000 / 30) {
        lastDraw = now;
        context.clearRect(0, 0, width, height);
        const time = now / 1000;
        const count = width < 700 ? 15 : motes.length;
        for (let index = 0; index < count; index += 1) {
          const mote = motes[index];
          const x =
            (mote.x + Math.sin(time * mote.speed + mote.phase) * 0.014) * width;
          const y =
            (mote.y + Math.cos(time * mote.speed * 0.6 + mote.phase) * 0.018) *
            height;
          context.fillStyle =
            index % 7 === 0
              ? `rgba(255, 52, 55, ${mote.alpha})`
              : `rgba(240, 238, 231, ${mote.alpha})`;
          context.beginPath();
          context.arc(x, y, mote.size, 0, Math.PI * 2);
          context.fill();
        }
      }
      frame = requestAnimationFrame(draw);
    }

    function sync() {
      if (visible && !document.hidden && shouldAnimate()) {
        if (!frame) frame = requestAnimationFrame(draw);
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        context.clearRect(0, 0, width, height);
      }
    }

    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener("resize", resize, { passive: true });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        sync();
      }).observe(canvas.closest(".hero") || canvas);
    }
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", () => {
      cancelAnimationFrame(frame);
      frame = 0;
    });
    window.addEventListener("pageshow", sync);
    resize();
    return { sync };
  })();

  function rebuildMotion() {
    interactionAnimations.forEach((animation) => animation.cancel());
    interactionAnimations.clear();
    motionMedia?.revert();
    motionMedia = null;
    motionContext?.revert();
    motionContext = null;
    body.classList.toggle("motion-enabled", shouldAnimate());
    body.classList.toggle("motion-paused", !shouldAnimate());
    if (shouldAnimate()) {
      motionContext = gsap.context(() => {
        const hero = query(".hero");
        const passage = query(".boundary-passage");
        const open = query(".open-visual");
        motionMedia = gsap.matchMedia();
        motionMedia.add(atlasIndexQuery, () => {
          const atlas = query(".atlas-map");
          if (!atlas) return;
          gsap.from(".atlas-node", {
            y: 16,
            opacity: 0.55,
            duration: 0.6,
            stagger: 0.035,
            clearProps: "opacity,transform",
            ease: "power3.out",
            scrollTrigger: { trigger: atlas, start: "top 85%", once: true },
          });
        });
        motionMedia.add("(min-width: 1000px)", () => {
          if (hero) {
            gsap.set(".hero-transition", { autoAlpha: 0, y: 70, scale: 0.94 });
            gsap
              .timeline({
                defaults: { ease: "none" },
                scrollTrigger: {
                  id: "hivra-hero",
                  trigger: hero,
                  start: "top top",
                  end: () => `+=${Math.round(innerHeight * 0.95)}`,
                  scrub: 1,
                  pin: true,
                  anticipatePin: 1,
                  invalidateOnRefresh: true,
                },
              })
              .to(
                ".hero-content",
                { xPercent: -12, y: -24, autoAlpha: 0, duration: 0.58 },
                0,
              )
              .to(
                ".hero-art",
                {
                  scale: 1.22,
                  xPercent: -5,
                  transformOrigin: "70% 48%",
                  duration: 1,
                },
                0,
              )
              .to(".hero-caption", { autoAlpha: 0, y: 20, duration: 0.28 }, 0)
              .to(
                ".hero-transition",
                { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 },
                0.42,
              );
          }
        });
        motionMedia.add(
          { compact: "(max-width: 999px)", tall: "(min-height: 600px)" },
          (context) => {
            if (!hero || !context.conditions.compact) return;
            // A shorter, vertical reveal for portrait touch scrolling. A short
            // landscape viewport stays in normal flow instead of trapping a tall hero.
            const portraitScene = context.conditions.tall;
            gsap.set(".hero-transition", { autoAlpha: 0, y: 38, scale: 0.97 });
            gsap
              .timeline({
                defaults: { ease: "none" },
                scrollTrigger: {
                  id: "hivra-hero",
                  trigger: hero,
                  start: "top top",
                  end: portraitScene
                    ? () => `+=${Math.round(hero.offsetHeight * 0.62)}`
                    : "bottom top",
                  scrub: 0.45,
                  pin: portraitScene,
                  anticipatePin: 1,
                  invalidateOnRefresh: true,
                },
              })
              .to(".hero-content", { y: -48, autoAlpha: 0, duration: 0.42 }, 0)
              .to(".hero-caption", { autoAlpha: 0, duration: 0.2 }, 0)
              .to(
                ".hero-art",
                {
                  scale: 1.12,
                  yPercent: -3,
                  transformOrigin: "67% 50%",
                  duration: 1,
                },
                0,
              )
              .to(
                ".hero-transition",
                { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 },
                0.38,
              );
          },
        );

        if (passage) {
          const frames = all(".passage-lines i", passage);
          const roomWords = all(".passage-room .wi", passage);
          const decideWords = all(".passage-decide .wi", passage);
          // Room, then a decision: the frames open out loose around the first
          // line, then square up and close in as the second line lands.
          const passageScene = (timeline, unit) =>
            timeline
              .fromTo(
                frames,
                {
                  scale: (index) => 0.12 + index * 0.02,
                  rotation: (index) => (index % 2 ? 1 : -1) * (18 + index * 4),
                  opacity: 0,
                },
                {
                  scale: (index) => 1.3 + (index % 3) * 0.06,
                  rotation: (index) => (index % 2 ? 1 : -1) * (4 + index * 1.4),
                  opacity: 0.55,
                  duration: 0.42 * unit,
                  stagger: 0.016 * unit,
                  ease: "power2.out",
                },
                0,
              )
              .fromTo(
                roomWords,
                { yPercent: 118 },
                {
                  yPercent: 0,
                  duration: 0.22 * unit,
                  stagger: 0.035 * unit,
                  ease: "power3.out",
                },
                0.05 * unit,
              )
              .to(
                frames,
                {
                  scale: 1,
                  rotation: 0,
                  opacity: 0.6,
                  duration: 0.3 * unit,
                  stagger: { each: 0.02 * unit, from: "end" },
                  ease: "power3.inOut",
                },
                0.48 * unit,
              )
              .fromTo(
                decideWords,
                { yPercent: 118 },
                {
                  yPercent: 0,
                  duration: 0.22 * unit,
                  stagger: 0.04 * unit,
                  ease: "power3.out",
                },
                0.62 * unit,
              )
              .fromTo(
                frames[6],
                { "--glow": 0 },
                { "--glow": 1, opacity: 1, duration: 0.12 * unit },
                0.8 * unit,
              );
          motionMedia.add("(min-width: 1000px) and (min-height: 700px)", () => {
            gsap.set(passage, { height: "100vh" });
            passageScene(
              gsap.timeline({
                defaults: { ease: "none" },
                scrollTrigger: {
                  id: "hivra-passage",
                  trigger: passage,
                  start: "top top",
                  end: () => `+=${Math.round(innerHeight * 1.5)}`,
                  scrub: 0.8,
                  pin: true,
                  anticipatePin: 1,
                  invalidateOnRefresh: true,
                },
              }),
              1,
            ).to({}, { duration: 0.14 });
          });
          motionMedia.add("(max-width: 999px), (max-height: 699px)", () => {
            const scene = passageScene(gsap.timeline({ paused: true }), 2.6);
            ScrollTrigger.create({
              trigger: passage,
              start: "top 68%",
              once: true,
              onEnter: () => scene.play(),
            });
          });
        }
        if (open)
          all(".open-frame", open).forEach((frame, index) => {
            gsap.fromTo(
              frame,
              {
                xPercent: (index - 1) * -7,
                yPercent: (index - 1) * -5,
                rotationZ: -12 + index * 6,
                z: -80,
              },
              {
                xPercent: (index - 1) * 28,
                yPercent: (index - 1) * 22,
                rotationZ: -22 + index * 23,
                z: index * 70,
                ease: "none",
                scrollTrigger: {
                  trigger: open,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 1.1,
                },
              },
            );
          });

        const fit = query(".fit");
        if (fit) {
          const options = all(".fit-option", fit);
          gsap
            .timeline({
              scrollTrigger: {
                trigger: query(".fit-options", fit),
                start: "top 80%",
                once: true,
              },
            })
            .from(options, {
              y: 40,
              opacity: 0,
              duration: 0.8,
              stagger: 0.14,
              ease: "power3.out",
            })
            .fromTo(
              options,
              { "--fill": 0 },
              { "--fill": 1, duration: 0.9, stagger: 0.14, ease: "power2.inOut" },
              0.15,
            );
          gsap.from(query(".fit-verdict", fit), {
            y: 34,
            opacity: 0,
            duration: 0.9,
            ease: "power3.out",
            scrollTrigger: {
              trigger: query(".fit-verdict", fit),
              start: "top 82%",
              once: true,
            },
          });
          const frame = query(".fit-frame", fit);
          const scene = gsap
            .timeline({
              scrollTrigger: {
                trigger: query(".fit-table", fit),
                start: "top 76%",
                once: true,
              },
            })
            .from(all(".fit-table tbody tr", fit), {
              opacity: 0,
              x: -20,
              duration: 0.55,
              stagger: 0.09,
              ease: "power3.out",
            })
            .fromTo(
              all(".fit-table td.is-hivra", fit),
              { "--pop": 0 },
              {
                "--pop": 1,
                duration: 0.45,
                stagger: 0.09,
                ease: "back.out(2.6)",
              },
              0.3,
            );
          if (frame)
            scene.fromTo(
              frame,
              { clipPath: "inset(0 0 100% 0)" },
              { clipPath: "inset(0 0 0% 0)", duration: 1, ease: "power2.inOut" },
              0.2,
            );
        }

        const rule = query(".delegation");
        if (rule) {
          // Each step lands in turn, and the blocked one is struck through last.
          gsap
            .timeline({
              scrollTrigger: { trigger: rule, start: "top 78%", once: true },
            })
            .from(all(".rule-step", rule), {
              y: 34,
              opacity: 0,
              duration: 0.7,
              stagger: 0.28,
              ease: "power3.out",
            })
            .from(
              all(".rule-verdict", rule),
              { opacity: 0, x: -10, duration: 0.4, stagger: 0.28 },
              0.35,
            );
        }

        // The four scenes stack; each image eases in and its word drifts.
        all(".quality-panel").forEach((panel) => {
          const word = query(".quality-word", panel);
          const figure = query(".quality-layout figure", panel);
          if (word)
            gsap.fromTo(
              word,
              { xPercent: -3 },
              {
                xPercent: 3,
                ease: "none",
                scrollTrigger: {
                  trigger: panel,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 1,
                },
              },
            );
          if (figure)
            gsap.from(query("img", figure), {
              scale: 1.14,
              opacity: 0,
              duration: 1.2,
              ease: "power3.out",
              scrollTrigger: { trigger: panel, start: "top 70%", once: true },
            });
        });

        all(
          ".chapter-heading h2, .founder-heading h2, .open-copy h2, .reading-room h2, .finale h2",
        ).forEach((heading) => {
          gsap.from(heading, {
            y: 42,
            opacity: 0.5,
            duration: 1,
            ease: "power3.out",
            scrollTrigger: { trigger: heading, start: "top 91%", once: true },
          });
        });
        const constitution = query(".constitution-statement");
        if (constitution)
          gsap.from(".constitutional-frame", {
            scaleY: 0.55,
            transformOrigin: "center top",
            opacity: 0.3,
            ease: "none",
            scrollTrigger: {
              trigger: constitution,
              start: "top 85%",
              end: "center center",
              scrub: 0.8,
            },
          });
        const settlement = query(".settlement-scene");
        if (settlement)
          gsap.to(".settlement-orbit", {
            rotation: 95,
            ease: "none",
            scrollTrigger: {
              trigger: settlement,
              start: "top bottom",
              end: "bottom top",
              scrub: 1,
            },
          });
        const finale = query(".finale");
        if (finale)
          gsap.fromTo(
            ".finale-art",
            { yPercent: 9 },
            {
              yPercent: -7,
              ease: "none",
              scrollTrigger: {
                trigger: finale,
                start: "top bottom",
                end: "bottom top",
                scrub: 1,
              },
            },
          );
      }, body);
    }
    particles.sync();
    refreshLayout();
  }

  function renderReaderControls() {
    all(".reading-toggle").forEach((button) => {
      button.setAttribute("aria-pressed", String(reading));
      button.setAttribute(
        "aria-label",
        reading
          ? "Return to the animated experience"
          : "Show continuous reading mode",
      );
      if (button.closest(".reader-tools"))
        button.textContent = reading ? "Experience" : "Read";
      else
        button.innerHTML = `${reading ? "Return to the experience" : "Continuous reading"} <span class="action-arrow" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10"/><path d="M17 8v9H8"/></svg></span>`;
    });
    all(".motion-toggle").forEach((button) => {
      button.disabled = reading || !motionAvailable;
      button.textContent = shouldAnimate() ? "Motion on" : "Motion off";
      button.setAttribute("aria-pressed", String(!shouldAnimate()));
      button.setAttribute(
        "aria-label",
        reading
          ? "Animation paused in reading mode"
          : !motionAvailable
            ? "Animation unavailable; continuous content remains readable"
            : shouldAnimate()
              ? "Pause animation"
              : "Resume animation",
      );
    });
  }

  function captureReadingPlace() {
    const hero = query(".hero");
    const heroTrigger = motionAvailable && ScrollTrigger.getById("hivra-hero");
    if (
      hero &&
      heroTrigger &&
      window.scrollY >= heroTrigger.start &&
      window.scrollY <= heroTrigger.end
    ) {
      // Mid-crossfade there may be no visible paragraph to bookmark. Keep the
      // scene's progress so pausing cannot strand the reader below its headline.
      return { element: hero, heroProgress: heroTrigger.progress };
    }
    const candidates = all("main h2, main h3, main p")
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
      }))
      .filter(
        ({ element, rect }) =>
          rect.height > 0 &&
          rect.bottom > 90 &&
          rect.top < innerHeight &&
          rect.right > 0 &&
          rect.left < innerWidth &&
          getComputedStyle(element).visibility !== "hidden",
      );
    candidates.sort(
      (a, b) => Math.abs(a.rect.top - 140) - Math.abs(b.rect.top - 140),
    );
    const place = candidates[0];
    if (!place) return null;
    const panel = place.element.closest(".quality-panel");
    const stage = panel?.closest(".quality-stage");
    const horizontal =
      motionAvailable && ScrollTrigger.getById("hivra-qualities");
    return {
      element: place.element,
      top: place.rect.top,
      quality:
        panel && stage
          ? {
              panel,
              // Store a viewport fraction so the bookmark survives a width change too.
              viewportOffset: horizontal
                ? (panel.getBoundingClientRect().left -
                    stage.getBoundingClientRect().left) /
                  Math.max(1, stage.clientWidth)
                : 0,
            }
          : null,
    };
  }

  function restoreReadingPlace(place) {
    if (!place) return;
    afterLayout(() => {
      if (typeof place.heroProgress === "number") {
        const heroTrigger =
          motionAvailable && ScrollTrigger.getById("hivra-hero");
        if (heroTrigger) {
          scrollToPosition(
            heroTrigger.start +
              place.heroProgress * (heroTrigger.end - heroTrigger.start),
          );
          heroTrigger.getTween()?.progress(1);
          heroTrigger.animation?.progress(place.heroProgress, true);
        } else {
          scrollToPosition(
            window.scrollY + place.element.getBoundingClientRect().top,
          );
        }
        updateChapter();
        return;
      }
      const horizontal =
        motionAvailable && ScrollTrigger.getById("hivra-qualities");
      if (horizontal && place.quality) {
        const track = query(".quality-track");
        const stage = query(".quality-stage");
        if (track && stage) {
          const distance = Math.max(1, track.scrollWidth - window.innerWidth);
          // Rect subtraction cancels the shared GSAP translation and yields the panel's
          // logical position in the track, irrespective of its CSS offset parent.
          const panelOffset =
            place.quality.panel.getBoundingClientRect().left -
            track.getBoundingClientRect().left;
          const desiredTranslation =
            panelOffset - place.quality.viewportOffset * stage.clientWidth;
          const progress = Math.max(
            0,
            Math.min(1, desiredTranslation / distance),
          );
          scrollToPosition(
            horizontal.start + progress * (horizontal.end - horizontal.start),
          );
          // Restore the bookmarked pane immediately instead of scrubbing from pane one.
          horizontal.getTween()?.progress(1);
          horizontal.animation?.progress(progress, true);
          updateChapter();
          return;
        }
      }
      const next = place.element.getBoundingClientRect();
      if (!next.height) return;
      scrollToPosition(window.scrollY + next.top - place.top);
      updateChapter();
    });
  }

  all(".reading-toggle").forEach((button) =>
    button.addEventListener("click", () => {
      const place = captureReadingPlace();
      const currentPanel = place?.element.closest(".product-panel");
      if (reading && currentPanel)
        activeProduct = currentPanel.id.replace(/^product-/, "");
      reading = !reading;
      // Revert pins before applying the static layout so their spacers cannot survive the switch.
      motionMedia?.revert();
      motionContext?.revert();
      motionMedia = null;
      motionContext = null;
      body.classList.toggle("reading-mode", reading);
      renderProducts();
      rebuildMotion();
      renderReaderControls();
      restoreReadingPlace(place);
    }),
  );

  all(".motion-toggle").forEach((button) =>
    button.addEventListener("click", () => {
      const place = captureReadingPlace();
      motionPreference = motionAllowed() ? "off" : "on";
      preference.set("hivra-litepaper-motion", motionPreference);
      rebuildMotion();
      renderReaderControls();
      restoreReadingPlace(place);
    }),
  );
  listenMedia(reducedMotion, () => {
    rebuildMotion();
    renderReaderControls();
  });

  const chapters = all("[data-chapter]");
  const dockLinks = all('.chapter-dock a[href^="#"]');
  const dockCurrentLabels = all(".dock-current");
  let chapterFrame = 0;
  function scheduleChapterUpdate() {
    if (chapterFrame) return;
    chapterFrame = requestAnimationFrame(() => {
      chapterFrame = 0;
      updateChapter();
    });
  }
  function updateChapter() {
    let current = null;
    const threshold = window.innerHeight * 0.35;
    for (const chapter of chapters) {
      if (chapter.getBoundingClientRect().top <= threshold) current = chapter;
    }
    body.classList.toggle("at-cover", current?.id === "beginning");
    const chapterLabel = current?.dataset.chapter || "";
    dockCurrentLabels.forEach((label) => {
      if (label.textContent !== chapterLabel) label.textContent = chapterLabel;
    });
    let activeLink = null;
    if (current) {
      for (const link of dockLinks) {
        const section = document.getElementById(link.hash.slice(1));
        if (
          section &&
          (section === current ||
            section.compareDocumentPosition(current) &
              Node.DOCUMENT_POSITION_FOLLOWING)
        )
          activeLink = link;
      }
    }
    dockLinks.forEach((link) => {
      const active = link === activeLink;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }
  if ("IntersectionObserver" in window) {
    const chapterObserver = new IntersectionObserver(scheduleChapterUpdate, {
      rootMargin: "-15% 0px -55% 0px",
      threshold: 0,
    });
    chapters.forEach((chapter) => chapterObserver.observe(chapter));
  }
  dockLinks.forEach((link) =>
    link.addEventListener("click", scheduleChapterUpdate),
  );

  // The dock steps aside while the reader moves down the page, so it never
  // sits on a line they are reading, and returns as soon as they scroll back
  // up, reach the end or move keyboard focus into it.
  const dock = query(".chapter-dock");
  let dockLastY = window.scrollY;
  let dockTravel = 0;
  let dockFrame = 0;
  function updateDock() {
    dockFrame = 0;
    const y = window.scrollY;
    const delta = y - dockLastY;
    dockLastY = y;
    if (!delta) return;
    dockTravel =
      Math.sign(delta) === Math.sign(dockTravel) ? dockTravel + delta : delta;
    const atEnd = y + innerHeight >= root.scrollHeight - 200;
    if (atEnd || dockTravel < -40) body.classList.remove("dock-tucked");
    else if (dockTravel > 90) body.classList.add("dock-tucked");
  }
  if (dock) {
    window.addEventListener(
      "scroll",
      () => {
        if (!dockFrame) dockFrame = requestAnimationFrame(updateDock);
      },
      { passive: true },
    );
    dock.addEventListener("focusin", () => body.classList.remove("dock-tucked"));
  }

  root.classList.add("js-enhanced");
  renderProducts();
  if (motionAvailable) {
    try {
      gsap.registerPlugin(ScrollTrigger);
      const progress = query(".reading-progress");
      if (progress) {
        gsap.set(progress, { scaleX: 0, transformOrigin: "left center" });
        const setProgress = gsap.quickSetter(progress, "scaleX");
        progressTrigger = ScrollTrigger.create({
          id: "hivra-reading-progress",
          start: 0,
          end: () => Math.max(1, ScrollTrigger.maxScroll(window)),
          onUpdate: (self) => {
            setProgress(self.progress);
            scheduleChapterUpdate();
          },
          onRefresh: (self) => {
            setProgress(self.progress);
            updateChapter();
          },
        });
      }
      rebuildMotion();
    } catch (error) {
      // A failed enhancement must never leave the document trapped in a pinned or hidden state.
      motionMedia?.revert();
      motionContext?.revert();
      progressTrigger?.kill();
      motionAvailable = false;
      body.classList.remove("motion-enabled");
      body.classList.add("motion-paused");
      particles.sync();
      console.warn(
        "Hivra animation enhancement could not start; the litepaper remains readable.",
        error,
      );
    }
  } else {
    body.classList.add("motion-paused");
  }
  // A long chapter can cross the selection threshold without entering or leaving
  // the observer's band. Reuse scroll progress updates; listen directly only when
  // that enhancement is unavailable (including its failure fallback).
  if (!motionAvailable || !progressTrigger)
    window.addEventListener("scroll", scheduleChapterUpdate, { passive: true });
  renderReaderControls();
  updateChapter();
  window.addEventListener("load", refreshLayout, { once: true });
  if (document.fonts?.ready) document.fonts.ready.then(refreshLayout);

  // The browser's initial fragment jump can precede the hero and horizontal
  // pin spacers. Restore its destination once their final layout is measurable.
  // A reader who has already started navigating keeps control of the page.
  const initialHash = location.hash;
  if (initialHash) {
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    const inputs = ["pointerdown", "touchstart", "wheel", "keydown"];
    inputs.forEach((type) =>
      window.addEventListener(type, interrupt, { passive: true }),
    );
    const loaded =
      document.readyState === "complete"
        ? Promise.resolve()
        : new Promise((resolve) =>
            window.addEventListener("load", resolve, { once: true }),
          );
    Promise.all([loaded, document.fonts?.ready]).then(() => {
      afterLayout(() => {
        inputs.forEach((type) => window.removeEventListener(type, interrupt));
        if (interrupted || location.hash !== initialHash) return;
        if (initialHash.startsWith("#product-")) {
          showProductFromHash();
          return;
        }
        let id;
        try {
          id = decodeURIComponent(initialHash.slice(1));
        } catch {
          return;
        }
        const target = document.getElementById(id);
        if (!target) return;
        const header = query(".site-header");
        const headerPosition = header ? getComputedStyle(header).position : "";
        const headerMargin =
          header && (headerPosition === "fixed" || headerPosition === "sticky")
            ? header.getBoundingClientRect().bottom + 18
            : 0;
        const margin = Math.max(
          parseFloat(getComputedStyle(root).scrollPaddingTop) || 0,
          parseFloat(getComputedStyle(target).scrollMarginTop) || 0,
          headerMargin,
        );
        scrollToPosition(
          Math.max(
            0,
            window.scrollY + target.getBoundingClientRect().top - margin,
          ),
        );
        updateChapter();
      });
    });
  }
})();

// Tooltips for plain-English terms: keep each one on screen, flip it under the
// word near the top, and let Escape close it.
(() => {
  const place = (term) => {
    const width = Math.min(300, window.innerWidth - 32);
    const box = term.getBoundingClientRect();
    const left = Math.max(16, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - 16 - width));
    term.style.setProperty("--gloss-x", `${left - box.left}px`);
    term.style.setProperty("--gloss-w", `${width}px`);
    if (box.top < 170) term.setAttribute("data-below", "");
    else term.removeAttribute("data-below");
  };
  const find = (event) => event.target instanceof Element ? event.target.closest(".gloss") : null;
  document.addEventListener("pointerover", (event) => { const term = find(event); if (term) place(term); });
  document.addEventListener("focusin", (event) => { const term = find(event); if (term) place(term); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.activeElement?.classList?.contains("gloss")) document.activeElement.blur();
  });
})();
