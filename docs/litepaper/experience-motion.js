/* Optional scene and chapter-index enhancements. Load after litepaper.js.
 *
 * Markup / CSS hooks:
 * - Prefer <dialog class="chapter-index-panel" id="chapter-index" aria-label="Chapters">.
 *   Its toggle gets aria-controls/aria-expanded; .chapter-index-close closes it.
 *   Style dialog:not([open]) and [hidden] as display:none. Use ::backdrop for the overlay.
 *   A non-dialog panel receives role=dialog, inert background and a focus trap instead.
 * - .scene-reveal receives .is-in-view once. Its default CSS must remain visible;
 *   gate entrance animation with body.motion-enabled:not(.reading-mode).
 * - A .chapter-masthead wrapper gets one short WAAPI entry. Existing h2 motion stays
 *   with litepaper.js. If the wrapper also has .scene-reveal, CSS owns its entrance
 *   instead, so the two effects cannot fight over transforms.
 * - .hero-object-stage receives unitless --pointer-x / --pointer-y in [-1, 1].
 *   Use these on an inner model transform, e.g. rotateY(calc(var(--pointer-x, 0) * 5deg)).
 *   This layer never writes transform itself, creates scroll pins, or intercepts hashes.
 * - .experience-enhanced marks successful setup; body.chapter-index-open marks the modal.
 *   Page lifecycle, visibility, pointer capability and the existing body motion classes
 *   cancel owned work. Reduced-motion and reader preferences remain owned by litepaper.js.
 */
(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  if (!body || root.classList.contains("experience-enhanced")) return;
  const events = new AbortController();
  const cleanups = [];
  const animations = new Set();
  const listen = (target, name, handler, options = {}) =>
    target.addEventListener(name, handler, {
      ...options,
      signal: events.signal,
    });
  const motionEnabled = () =>
    !document.hidden &&
    body.classList.contains("motion-enabled") &&
    !body.classList.contains("motion-paused") &&
    !body.classList.contains("reading-mode") &&
    !body.classList.contains("chapter-index-open");

  // The chapter index is a modal document navigation surface, not an application menu.
  const panel = document.querySelector(".chapter-index-panel");
  const toggles = [...document.querySelectorAll(".chapter-index-toggle")];
  if (panel && toggles.length) {
    const nativeDialog = typeof panel.showModal === "function";
    const inertBefore = new Map();
    let open = false;
    let returnFocus = null;
    if (!panel.id) {
      let id = "chapter-index";
      while (document.getElementById(id)) id += "-panel";
      panel.id = id;
    }
    if (
      !panel.hasAttribute("aria-label") &&
      !panel.hasAttribute("aria-labelledby")
    )
      panel.setAttribute("aria-label", "Chapters");
    if (!nativeDialog) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
    }
    if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
    toggles.forEach((toggle) => {
      toggle.setAttribute("aria-controls", panel.id);
      toggle.setAttribute("aria-haspopup", "dialog");
      toggle.setAttribute("aria-expanded", "false");
    });
    panel.hidden = true;

    const focusable = () =>
      [
        ...panel.querySelectorAll(
          "a[href], button, input, select, textarea, [tabindex]",
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.disabled &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== "hidden",
      );
    const restoreBackground = () => {
      inertBefore.forEach((value, element) => {
        element.inert = value;
      });
      inertBefore.clear();
    };
    const setOpenState = (value) => {
      open = value;
      body.classList.toggle("chapter-index-open", value);
      panel.classList.toggle("is-open", value);
      toggles.forEach((toggle) =>
        toggle.setAttribute("aria-expanded", String(value)),
      );
    };
    function closeIndex(restoreFocus = true) {
      if (!open) return;
      setOpenState(false);
      if (nativeDialog && panel.open) panel.close();
      panel.hidden = true;
      restoreBackground();
      if (restoreFocus && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true });
    }
    function openIndex(toggle) {
      if (open) return;
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : toggle;
      panel.hidden = false;
      if (nativeDialog) panel.showModal();
      else {
        // Inert siblings at every ancestor level, so nested overlay markup also works.
        let branch = panel;
        while (branch.parentElement && branch !== body) {
          [...branch.parentElement.children].forEach((sibling) => {
            if (sibling === branch || !(sibling instanceof HTMLElement)) return;
            inertBefore.set(sibling, sibling.inert);
            sibling.inert = true;
          });
          branch = branch.parentElement;
        }
      }
      setOpenState(true);
      (focusable()[0] || panel).focus({ preventScroll: true });
    }
    toggles.forEach((toggle) =>
      listen(toggle, "click", () => (open ? closeIndex() : openIndex(toggle))),
    );
    panel.querySelectorAll(".chapter-index-close").forEach((button) =>
      listen(button, "click", (event) => {
        event.preventDefault();
        closeIndex();
      }),
    );
    listen(panel, "cancel", (event) => {
      event.preventDefault();
      closeIndex();
    });
    listen(panel, "close", () => {
      if (!panel.open) closeIndex();
    });
    listen(panel, "click", (event) => {
      if (!open || event.button !== 0) return;
      const bounds = panel.getBoundingClientRect();
      const outside =
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom;
      if (event.target === panel && (!nativeDialog || outside)) closeIndex();
    });
    listen(
      panel,
      "click",
      (event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link =
          event.target instanceof Element
            ? event.target.closest("a[href]")
            : null;
        if (!link) return;
        const destination = new URL(link.href, location.href);
        if (
          destination.origin === location.origin &&
          destination.pathname === location.pathname &&
          destination.search === location.search &&
          destination.hash
        )
          closeIndex(false); // No preventDefault: existing navigation owns the fragment and scrolling.
      },
      { capture: true },
    );
    listen(panel, "keydown", (event) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeIndex();
      } else if (event.key === "Tab") {
        const stops = focusable();
        const first = stops[0] || panel;
        const last = stops[stops.length - 1] || panel;
        if (
          !stops.length ||
          (event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === panel))
        ) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === panel)
        ) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    });
    cleanups.push(() => closeIndex(false));
  }

  // Reading remains available before observer callbacks and when JS/WAAPI is unavailable.
  const revealTargets = [
    ...document.querySelectorAll(".chapter-masthead, .scene-reveal"),
  ];
  function enterScene(element) {
    element.classList.add("is-in-view");
    if (
      !element.classList.contains("chapter-masthead") ||
      element.matches("h2") ||
      element.classList.contains("scene-reveal") ||
      !motionEnabled() ||
      !element.animate
    )
      return;
    const animation = element.animate(
      [
        { opacity: 0.65, transform: "translateY(20px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 850, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    animations.add(animation);
    animation.finished.then(
      () => animations.delete(animation),
      () => animations.delete(animation),
    );
  }
  if ("IntersectionObserver" in window) {
    const reveals = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          reveals.unobserve(entry.target);
          enterScene(entry.target);
        });
      },
      { threshold: 0, rootMargin: "0px 0px -6% 0px" },
    );
    revealTargets.forEach((element) => reveals.observe(element));
    cleanups.push(() => reveals.disconnect());
  } else
    revealTargets.forEach((element) => element.classList.add("is-in-view"));

  // Pointer movement controls only custom properties on an inner hero model layer.
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const pointerResets = [];
  document.querySelectorAll(".hero-object-stage").forEach((stage) => {
    const surface = stage.closest(".hero") || stage;
    let visible = true;
    let frame = 0;
    let x = 0,
      y = 0,
      targetX = 0,
      targetY = 0;
    function write() {
      stage.style.setProperty("--pointer-x", x.toFixed(4));
      stage.style.setProperty("--pointer-y", y.toFixed(4));
    }
    function reset() {
      cancelAnimationFrame(frame);
      frame = 0;
      x = y = targetX = targetY = 0;
      write();
    }
    function tick() {
      frame = 0;
      if (!visible || !motionEnabled() || !finePointer.matches) {
        reset();
        return;
      }
      x += (targetX - x) * 0.14;
      y += (targetY - y) * 0.14;
      if (Math.abs(targetX - x) < 0.002 && Math.abs(targetY - y) < 0.002) {
        x = targetX;
        y = targetY;
      } else frame = requestAnimationFrame(tick);
      write();
    }
    listen(
      surface,
      "pointermove",
      (event) => {
        if (
          !visible ||
          !motionEnabled() ||
          !finePointer.matches ||
          event.pointerType === "touch"
        )
          return;
        const bounds = surface.getBoundingClientRect();
        targetX = Math.max(
          -1,
          Math.min(
            1,
            ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
          ),
        );
        targetY = Math.max(
          -1,
          Math.min(
            1,
            ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 - 1,
          ),
        );
        if (!frame) frame = requestAnimationFrame(tick);
      },
      { passive: true },
    );
    listen(
      surface,
      "pointerleave",
      () => {
        targetX = targetY = 0;
        if (!frame) frame = requestAnimationFrame(tick);
      },
      { passive: true },
    );
    if ("IntersectionObserver" in window) {
      const visibility = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (!visible) reset();
      });
      visibility.observe(surface);
      cleanups.push(() => visibility.disconnect());
    }
    pointerResets.push(reset);
    cleanups.push(reset);
  });
  function pauseMotion() {
    animations.forEach((animation) => animation.cancel());
    animations.clear();
    pointerResets.forEach((reset) => reset());
  }
  const modeObserver = new MutationObserver(() => {
    if (!motionEnabled()) pauseMotion();
  });
  modeObserver.observe(body, { attributes: true, attributeFilter: ["class"] });
  cleanups.push(() => modeObserver.disconnect());
  listen(document, "visibilitychange", () => {
    if (document.hidden) pauseMotion();
  });
  listen(window, "blur", pauseMotion);
  listen(finePointer, "change", () => {
    if (!finePointer.matches) pauseMotion();
  });
  listen(window, "pagehide", (event) => {
    pauseMotion();
    if (event.persisted) return; // Keep observers/listeners for the browser's back-forward cache.
    cleanups.forEach((cleanup) => cleanup());
    events.abort();
    root.classList.remove("experience-enhanced");
  });
  root.classList.add("experience-enhanced");
})();
