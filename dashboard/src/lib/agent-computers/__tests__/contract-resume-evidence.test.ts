// Manage says "applies from its next message" only where spike S3 proved a
// resumed turn reads the contract again: attached Codex 0.149.1 (design 4.6, 5.4).
import { readFileSync } from "node:fs";
import path from "node:path";

import { ATTACHED_CODEX_VERSION, contractAppliesTo, contractAppliesToLabel } from "../contract-resume-evidence";

it("applies from the next message only for the pinned attached Codex", () => {
  expect(contractAppliesTo({ runtime: "codex", version: ATTACHED_CODEX_VERSION, surface: "attached" })).toBe("next-message");
  expect(contractAppliesTo({ runtime: "codex", version: "0.150.0", surface: "attached" })).toBe("new-chats");
  expect(contractAppliesTo({ runtime: "codex", version: ATTACHED_CODEX_VERSION, surface: "own-computer" })).toBe("new-chats");
  expect(contractAppliesTo({ runtime: "claude-code", version: null, surface: "own-computer" })).toBe("new-chats");
  expect(contractAppliesToLabel("next-message")).toBe("applies from its next message");
  expect(contractAppliesToLabel("new-chats")).toBe("applies to new chats");
});

it("pins the same Codex version the stager installs", () => {
  const stager = readFileSync(path.join(process.cwd(), "provisioner", "stage-attached-codex.py"), "utf8");
  expect(stager).toContain(ATTACHED_CODEX_VERSION);
});
