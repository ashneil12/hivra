import fs from "fs";
import path from "path";
import postcss from "postcss";

describe("chat text animation contract", () => {
  const globalsCss = fs.readFileSync(path.join(__dirname, "..", "globals.css"), "utf8");

  it("uses a premium reveal instead of the old upward-only fade", () => {
    expect(globalsCss).toContain("@keyframes chat-text-reveal");
    expect(globalsCss).toContain("filter: blur(6px)");
    expect(globalsCss).toContain("transform: translate3d(0, 4px, 0) scale(0.992)");
    expect(globalsCss).toContain(".animate-fade-up { animation: chat-text-reveal 0.38s");
  });

  it("removes the reveal motion for reduced-motion users", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalsCss).toContain(".animate-fade-up { animation: none;");
  });
});


describe("Hivra chat motion accessibility", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "globals.css"), "utf8");
  const css = postcss.parse(source);
  const chatSource = fs.readFileSync(path.join(__dirname, "../../components/hivra/HivraChat.tsx"), "utf8");
  const reducedMotionRules = () => {
    const rules: postcss.Rule[] = [];
    css.walkAtRules("media", (media) => {
      if (media.params === "(prefers-reduced-motion: reduce)") media.walkRules((rule) => { rules.push(rule); });
    });
    return rules;
  };
  const isUnlayered = (rule: postcss.Rule) => {
    for (let node: postcss.Node | undefined = rule.parent; node; node = node.parent) {
      if (node.type === "atrule" && ((node as postcss.AtRule).name === "layer" || (node as postcss.AtRule).name === "media")) return false;
    }
    return true;
  };
  const ms = (value: string) => value.split(",").map((v) => {
    const t = v.trim();
    return t.endsWith("ms") ? Number(t.slice(0, -2)) : Number(t.slice(0, -1)) * 1000;
  });

  it("disables every animation, transition and smooth scroll inside the chat root under reduced motion", () => {
    const scope = reducedMotionRules().find((rule) => [".hivra-chat-root *", ".hivra-chat-root *::before", ".hivra-chat-root *::after"].every((sel) => rule.selectors.includes(sel)));
    expect(scope).toBeDefined();
    const decls = new Map<string, postcss.Declaration>();
    scope!.walkDecls((decl) => { decls.set(decl.prop, decl); });
    // !important: the chat's own unlayered rules and Tailwind utilities must not win.
    expect(decls.get("animation")).toMatchObject({ value: "none", important: true });
    expect(decls.get("transition")).toMatchObject({ value: "none", important: true });
    expect(decls.get("scroll-behavior")).toMatchObject({ value: "auto", important: true });
  });

  it("renders the chat inside the element that scope targets", () => {
    // HivraChat's outermost element carries the class the reduced-motion scope keys on.
    expect(chatSource).toMatch(/return \(\s*<div className="hivra-chat-root"/);
  });

  it("only styles chat selectors HivraChat actually renders", () => {
    const classes = new Set<string>();
    css.walkRules((rule) => { for (const m of rule.selector.matchAll(/\.(hivra-chat-[a-z-]+)/g)) classes.add(m[1]); });
    for (const cls of ["hivra-chat-activity-wrap"]) expect(classes).not.toContain(cls);
    expect(source).not.toMatch(/\.hivra-chat-message \.animate-bounce/);
    for (const cls of classes) expect(chatSource).toContain(cls);
  });

  it.each([
    ".hivra-chat-message", ".hivra-chat-tool-history-list", ".hivra-chat-activity-dot.is-running", ".hivra-chat-spinner",
  ])("disables animation for %s inside the reduced-motion query", (selector) => {
    const disabled = reducedMotionRules().some((rule) => {
      if (!rule.selectors.includes(selector)) return false;
      let none = false;
      rule.walkDecls("animation", (decl) => { if (decl.value === "none") none = true; });
      return none;
    });
    expect(disabled).toBe(true);
  });

  it("keeps chat entrance motion within 120–200ms", () => {
    let entrances = 0;
    css.walkDecls("animation", (decl) => {
      if (!decl.value.startsWith("hivra-chat-activity-in")) return;
      const duration = Number(decl.value.match(/(\d+)ms/)?.[1]);
      expect(duration).toBeGreaterThanOrEqual(120);
      expect(duration).toBeLessThanOrEqual(200);
      entrances += 1;
    });
    expect(entrances).toBeGreaterThan(0);
  });

  it("gives chat controls 120–200ms transitions over the global 500ms control transition", () => {
    // The global theme transition is unlayered, so it beats Tailwind's layered
    // transition-colors on every chat button unless the chat overrides it.
    const global = css.nodes.find((n): n is postcss.Rule => n.type === "rule" && n.selectors.includes("button") && n.selectors.includes("textarea"));
    expect(global).toBeDefined();
    const chatControls = css.nodes.find((n): n is postcss.Rule => n.type === "rule" && ["button", "textarea", "input", "a"].every((el) => n.selectors.includes(`.hivra-chat-root ${el}`)));
    expect(chatControls).toBeDefined();
    expect(isUnlayered(chatControls!)).toBe(true);
    // The properties decide what animates at all: the rail's delete control fades
    // in via opacity, and hover/focus change colours, borders and focus rings.
    let properties: string[] = [];
    chatControls!.walkDecls("transition-property", (decl) => { properties = decl.value.split(",").map((p) => p.trim()); });
    expect(properties).toEqual(expect.arrayContaining(["color", "background-color", "border-color", "opacity", "box-shadow"]));
    expect(properties).not.toContain("all");
    let durations: number[] = [];
    chatControls!.walkDecls("transition-duration", (decl) => { durations = ms(decl.value); });
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(120);
      expect(d).toBeLessThanOrEqual(200);
    }
    // Any other unlayered chat rule that sets a transition stays in range too.
    css.walkDecls(/^transition(-duration)?$/, (decl) => {
      const rule = decl.parent as postcss.Rule;
      if (rule.type !== "rule" || !isUnlayered(rule) || !/hivra-chat/.test(rule.selector) || decl.value === "none") return;
      for (const m of decl.value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
        const d = m[2] === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
        expect(d).toBeGreaterThanOrEqual(120);
        expect(d).toBeLessThanOrEqual(200);
      }
    });
  });

  it("does not override reduced-motion spinner styles with inline animations", () => {
    expect(chatSource).not.toMatch(/animation\s*:/);
  });
});
