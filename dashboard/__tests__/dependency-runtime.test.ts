/** @jest-environment jsdom */
import createDOMPurify from "dompurify";

describe("DOMPurify detached-subtree regression", () => {
  it.each(["beforeSanitizeElements", "uponSanitizeElement"] as const)(
    "%s cannot leave an executable handler in a removed descendant",
    (hook) => {
      const purify = createDOMPurify(window);
      const root = document.createElement("div");
      root.innerHTML = '<footer><img onload="void 0"></footer><div>safe</div>';
      const image = root.querySelector("img")!;
      expect(image.getAttribute("onload")).toBe("void 0");
      const detachFooter = (node: Node) => {
        if (node.nodeName === "FOOTER") node.parentNode?.removeChild(node);
      };
      if (hook === "beforeSanitizeElements") purify.addHook(hook, detachFooter);
      else purify.addHook(hook, detachFooter);
      purify.sanitize(root, { ALLOWED_TAGS: ["div", "footer", "#text"], IN_PLACE: true });
      expect(root.innerHTML).toBe("<div>safe</div>");
      // Inspect the original detached object, not only the returned clean HTML.
      expect(image.getAttribute("onload")).toBeNull();
      purify.removeAllHooks();
    },
  );
});
