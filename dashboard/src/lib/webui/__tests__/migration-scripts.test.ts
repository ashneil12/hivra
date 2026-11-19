import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  buildProfileRuntimeValidationScript,
  buildProfileSeedScript,
  shQuote,
} from "@/lib/webui/migration-scripts";

function assignmentLines(script: string): string[] {
  return script.split("\n").filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line));
}

// Runs only the variable assignments of a built host script in bash and
// returns the resulting values, so command substitution would show up either
// as a changed value or as a side-effect file.
function evaluateAssignments(script: string, names: string[]): Record<string, string> {
  const body = [
    ...assignmentLines(script),
    ...names.map((name) => `printf '%s\\0' "$${name}"`),
  ].join("\n");
  const output = execFileSync("bash", ["-c", body], { encoding: "utf8" });
  const values = output.split("\0");
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

describe("WebUI migration host scripts", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "webui-migration-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("keeps a hostile custom base URL literal in the runtime validation script", () => {
    const marker = path.join(workDir, "pwned");
    const baseUrl = `https://x/$(touch ${marker})\`touch ${marker}\`'"$HOME`;
    const script = buildProfileRuntimeValidationScript({
      instanceId: "inst-1",
      profileName: "default",
      inferenceProvider: "custom",
      baseUrl,
      requiredKeyEnvVar: "OPENAI_API_KEY",
    });

    const values = evaluateAssignments(script, ["EXPECTED_BASE_URL", "EXPECTED_PROVIDER", "CONTAINER_NAME"]);

    expect(values.EXPECTED_BASE_URL).toBe(baseUrl);
    expect(values.EXPECTED_PROVIDER).toBe("custom");
    expect(values.CONTAINER_NAME).toBe("agent-inst-1");
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps hostile profile values literal in the seed script", () => {
    const marker = path.join(workDir, "pwned");
    const script = buildProfileSeedScript({
      instanceId: `inst$(touch ${marker})`,
      profileName: "default",
      configYaml: "model: x\n",
      envFile: "A=1\n",
    });

    const values = evaluateAssignments(script, ["CONTAINER_NAME"]);

    expect(values.CONTAINER_NAME).toBe(`agent-inst$(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
  });

  it("single-quotes values, escaping embedded single quotes", () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(execFileSync("bash", ["-c", `printf '%s' ${shQuote("a'b $(x)")}`], { encoding: "utf8" })).toBe(
      "a'b $(x)"
    );
  });
});
