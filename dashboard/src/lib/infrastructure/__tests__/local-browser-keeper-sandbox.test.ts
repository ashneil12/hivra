import { readFileSync } from "node:fs";
import path from "node:path";

// The agent's own browser (driven over CDP by Playwright and similar tools)
// opens arbitrary sites. It ran with Chromium's sandbox off; a renderer exploit
// then landed directly as the agent user. It must keep the sandbox on, and the
// unit that starts it must not take away the setuid helper the sandbox needs.
describe("agent browser sandbox", () => {
  const read = (name: string) => readFileSync(path.join(process.cwd(), "provisioner", name), "utf8");

  it("never launches Chrome with --no-sandbox", () => {
    const keeper = read("local-browser-keeper.py");
    expect(keeper).not.toMatch(/["']--no-sandbox["']/);
    expect(keeper).not.toMatch(/["']--disable-setuid-sandbox["']/);
  });

  it("keeps the keeper unit free of NoNewPrivileges, which would disable chrome-sandbox", () => {
    expect(read("bux-local-browser.service")).not.toMatch(/NoNewPrivileges\s*=\s*(yes|true|1)/i);
    const installer = read("provision-claude-code-box.sh");
    const dropIn = installer.slice(installer.indexOf("bux-local-browser.service.d/hivra-view.conf"));
    expect(dropIn.slice(0, dropIn.indexOf("UNIT\n", dropIn.indexOf("UNIT") + 4))).not.toMatch(/NoNewPrivileges/i);
  });

  it("lets a sandbox failure reach the service log instead of discarding it", () => {
    const keeper = read("local-browser-keeper.py");
    const launch = keeper.slice(keeper.indexOf("proc = subprocess.Popen("));
    expect(launch.slice(0, launch.indexOf(")"))).toContain("stderr=None");
  });
});
