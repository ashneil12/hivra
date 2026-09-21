import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIVATION_TREE_FILES = [
  "src/app/get-started/activate/page.tsx",
  "src/components/dashboard/welcome/WelcomeFlow.tsx",
  "src/components/dashboard/welcome/DeployForm.tsx",
];

describe("Fleet activation React key stability", () => {
  it("does not key activation list items by render index", () => {
    const unstableKeyMatches = ACTIVATION_TREE_FILES.flatMap((relativePath) => {
      const file = readFileSync(join(process.cwd(), relativePath), "utf8");

      return file
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1, relativePath }))
        .filter(({ line }) => /\bkey=\{(?:i|idx|index)\}/.test(line.trim()));
    });

    expect(unstableKeyMatches).toEqual([]);
  });

  it("does not reference the removed remainingLaunchItems variable in DeployForm", () => {
    const deployForm = readFileSync(
      join(process.cwd(), "src/components/dashboard/welcome/DeployForm.tsx"),
      "utf8"
    );

    expect(deployForm).not.toContain("remainingLaunchItems");
  });
});
