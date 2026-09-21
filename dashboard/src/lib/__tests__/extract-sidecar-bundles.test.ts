import * as fs from "fs";

import { SIDECAR_SERVER_CODE } from "@/lib/services/sidecar-script";

// One-off helper: writes the compiled sidecar bundle to /tmp so we can
// SCP it to an instance VM and manually push a sidecar refresh without
// going through the dashboard's instance-security flow. Skip in CI.
describe.skip("extract sidecar bundles", () => {
  it("writes bundles to /tmp", () => {
    fs.writeFileSync("/tmp/sidecar_server.js", SIDECAR_SERVER_CODE);
    expect(true).toBe(true);
  });
});
