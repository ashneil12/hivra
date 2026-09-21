import { readFileSync } from "node:fs";
import path from "node:path";

describe("Hivra live browser geometry", () => {
  it("keeps the virtual display and Chrome window on the same landscape desktop size", () => {
    const provisioner = readFileSync(
      path.join(process.cwd(), "provisioner/provision-claude-code-box.sh"),
      "utf8",
    );
    const keeper = readFileSync(
      path.join(process.cwd(), "provisioner/local-browser-keeper.py"),
      "utf8",
    );
    const display = provisioner.match(/ExecStart=\/usr\/bin\/Xvfb :99 -screen 0 (\d+)x(\d+)x(\d+) /);
    const chromeWindow = keeper.match(/"--window-size=(\d+),(\d+)"/);

    // The old 1280x1800 portrait screen shrank to only 373px wide in a
    // 1208x525 dashboard panel. Both layers must change together: resizing only
    // Chrome would still stream the tall Xvfb framebuffer and its empty space.
    expect(display?.slice(1)).toEqual(["1280", "720", "24"]);
    expect(chromeWindow?.slice(1)).toEqual(display?.slice(1, 3));
  });

  it("keeps noVNC aspect-preserving fit rather than silently resizing the active desktop", () => {
    const page = readFileSync(
      path.join(process.cwd(), "src/app/dashboard/agent/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("&resize=scale&");
  });
});
