// The desktop's stream and its broker run as separate containers. The broker
// dials its stream on 127.0.0.1, so the stream must publish on the guest's
// loopback and the broker must share the guest's network namespace. Without
// both, every session authorised and then died within seconds, which reached
// the owner as "the desktop stream stopped before it finished opening" with no
// server-side error to look at.
//
// The shared provider-desktop bundle (broker.cjs/server.cjs) is release-identity
// gated by its own versioned manifests, so this lane is fixed in its own
// installer instead of by changing the broker.

import { readFileSync } from "node:fs";
import path from "node:path";

const read = (name: string) =>
  readFileSync(path.join(process.cwd(), "provisioner", "remote-desktop", name), "utf8");

describe("Omarchy desktop stream reachability", () => {
  it("publishes the stream on the guest's loopback for the broker", () => {
    const installer = read("install-omarchy-web.py");
    expect(installer).toContain("--publish 127.0.0.1:8080:8080");
  });

  it("runs the broker in the guest's network namespace, not a bridge of its own", () => {
    const installer = read("install-omarchy-web.py");
    const brokerUnit = installer.slice(installer.indexOf("broker_unit = "), installer.indexOf("layout_unit = layout_unit.replace"));
    expect(brokerUnit).toContain("--network host");
    expect(brokerUnit).not.toContain("-p {request['guestPrivateIpv4']}:8090:8090");
    expect(brokerUnit).not.toContain("--network {NETWORK}");
    // the stream keeps its own network for the display socket it mounts
    const streamUnit = installer.slice(installer.indexOf("selkies_unit = "), installer.indexOf("broker_unit = "));
    expect(streamUnit).toContain("--network {NETWORK}");
  });

  it("keeps the broker dialling the loopback its stream publishes on", () => {
    // If either side of this contract moves, both this lane's units and the
    // broker's own upstream have to move together.
    expect(read("broker.cjs")).toContain("`http://127.0.0.1:${options.upstreamPort}`");
    expect(read("omarchy-web-server.cjs")).toContain("upstreamPort: 8080");
  });

  it("does not redirect that loopback onto a container name", () => {
    // This lane's adapter used to rewrite 127.0.0.1:8080 to the stream's Docker
    // network name, which was right when the broker sat on its own bridge. Now
    // that the stream publishes on the guest loopback and the broker shares the
    // guest's network namespace, that rewrite sends every session to an address
    // the stream does not serve: the broker waits for a reply, the gateway times
    // out, and the desktop shows a 502 instead of opening. The adapter must stay
    // a pass-through to the shared broker.
    const adapter = read("omarchy-web-broker.cjs");
    expect(adapter).toContain("module.exports = require('./broker.cjs')");
    expect(adapter).not.toContain("http.request =");
    expect(adapter).not.toContain("hivra-omarchy-web'");
  });

  it("allows the gateway's port through the guest firewall", () => {
    // The broker is in the guest's network namespace, so this port is a guest
    // listener and the host firewall has to permit it for the gateway's hop.
    expect(read("install-omarchy-web.py")).toContain('"allow", "8090/tcp"');
  });

  it("lets the desktop user update the machine from inside it", () => {
    // Updating is safe now that the platform accepts every validated build, so
    // the installer grants the update commands (and only those).
    const installer = read("install-omarchy-web.py");
    expect(installer).toContain("/etc/sudoers.d/90-hivra-desktop");
    expect(installer).toContain("/usr/bin/omarchy-update");
    expect(installer).toContain('"/usr/bin/visudo", "-cf"');
  });
});
